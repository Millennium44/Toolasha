/** @vitest-environment happy-dom */

/**
 * Tests for Labyrinth Clear Rate live-estimate math
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/** Gear the mocked loadoutSnapshot reports; mutated in place (see setGear) so
 *  every holder of the mocked default export sees updates */
const gear = vi.hoisted(() => ({ snapshots: {} }));

/** Guild shrine data the mocked adapter and data manager report */
const shrines = vi.hoisted(() => ({ detailMap: {}, owned: {} }));

/** Backing store for the mocked storage module: `${storeName}:${key}` -> value */
const db = vi.hoisted(() => ({ map: new Map() }));

/** Backing store for the mocked config's settings */
const settings = vi.hoisted(() => ({ map: new Map() }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn(() => true),
        getSettingValue: (key, fallback) => (settings.map.has(key) ? settings.map.get(key) : fallback),
        setSettingValue: (key, value) => settings.map.set(key, value),
        Z_NOTIFICATION: 10500,
        Z_FLOATING_PANEL: 10100,
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: vi.fn(), register: vi.fn() } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: vi.fn(),
        off: vi.fn(),
        getSkills: vi.fn(() => []),
        getInitClientData: vi.fn(() => null),
        getCharacterGuildBuffLevel: (hrid) => shrines.owned[hrid] || 0,
        characterData: null,
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    buildPlayerDTO: vi.fn(),
    buildGameDataPayload: vi.fn(),
    applyLoadoutSnapshotToDTO: vi.fn(),
    getGuildBuffDetailMap: () => shrines.detailMap,
    applyGuildBuffLevel: (buffs, detail, level) => [
        ...buffs.filter((b) => b.typeHrid !== detail.buffs[0].typeHrid),
        { typeHrid: detail.buffs[0].typeHrid, flatBoost: detail.buffs[0].flatBoost * level, ratioBoost: 0 },
    ],
}));
vi.mock('../combat-sim/combat-sim-runner.js', () => ({ runLabyrinthSimulation: vi.fn() }));
// snapshots/resolveEquipment back the persisted-combat-cache gear fingerprint below;
// the rest of this file never touches loadout-snapshot, so {} was enough before it
vi.mock('./loadout-snapshot.js', () => ({
    default: {
        snapshots: gear.snapshots,
        onUpdate: () => {},
        offUpdate: () => {},
        resolveEquipment: (snapshot) => snapshot?.equipment || [],
    },
}));
// The persisted-combat-cache suite drives this store directly; every other
// suite in this file is pure math and never touches it
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, storeName = 'settings', defaultValue = null) => {
            const stored = db.map.get(`${storeName}:${key}`);
            return stored === undefined ? defaultValue : stored;
        },
        setJSON: async (key, value, storeName = 'settings') => {
            db.map.set(`${storeName}:${key}`, value);
            return true;
        },
    },
}));

const {
    default: labyrinthClearRate,
    computeLabyrinthPath,
    computeBeaconPlan,
    countDisjointRoutes,
    labyrinthGridSize,
    labyrinthRoomRewards,
} = await import('./labyrinth-clear-rate.js');

describe('normalizeChance', () => {
    test('passes through ratios and converts percent-form values', () => {
        expect(labyrinthClearRate.normalizeChance(0.8)).toBe(0.8);
        expect(labyrinthClearRate.normalizeChance(80)).toBe(0.8);
        expect(labyrinthClearRate.normalizeChance(1)).toBe(1);
        expect(labyrinthClearRate.normalizeChance(0)).toBe(0);
        expect(labyrinthClearRate.normalizeChance(-5)).toBe(0);
        expect(labyrinthClearRate.normalizeChance(undefined)).toBe(0);
    });
});

describe('clear-chance Markov math', () => {
    test('guaranteed success clears exactly when enough attempts remain', () => {
        // Needs 10 successes (100 work / 10 per success) with 100% success rate
        const enough = labyrinthClearRate.computeNonEnhancingClearStats(10, 1, 0, 10, 100);
        expect(enough.clearChance).toBeCloseTo(1, 9);
        expect(enough.expectedAttemptsOnClear).toBeCloseTo(10, 9);

        const tooFew = labyrinthClearRate.computeNonEnhancingClearStats(9, 1, 0, 10, 100);
        expect(tooFew.clearChance).toBe(0);
    });

    test('double progress halves the required attempts', () => {
        // 100% success and 100% double: 10 units in 5 attempts
        const result = labyrinthClearRate.computeNonEnhancingClearStats(5, 1, 1, 10, 100);
        expect(result.clearChance).toBeCloseTo(1, 9);
        expect(result.expectedAttemptsOnClear).toBeCloseTo(5, 9);
    });

    test('enhancing walk reaches the target only with enough attempts', () => {
        const enough = labyrinthClearRate.computeEnhancingClearStats(5, 1, 0, 5, 0);
        expect(enough.clearChance).toBeCloseTo(1, 9);

        const tooFew = labyrinthClearRate.computeEnhancingClearStats(4, 1, 0, 5, 0);
        expect(tooFew.clearChance).toBe(0);
    });

    test('enhancing failures walk the level back down', () => {
        // 50% success from level 0 to 1 in one attempt = 0.5
        const oneShot = labyrinthClearRate.computeEnhancingClearStats(1, 0.5, 0, 1, 0);
        expect(oneShot.clearChance).toBeCloseTo(0.5, 9);
    });
});

describe('computeLiveEstimate', () => {
    const baseMessage = {
        targetLevel: null,
        successRate: 0.8,
        doubleProgressChance: 0.1,
        actionTimeMs: 10000,
        actionCounter: 2,
        currentWorkValue: 30,
        targetWorkValue: 100,
        progressPerAction: 10,
    };

    test('computes a skilling estimate with remaining attempts', () => {
        const estimate = labyrinthClearRate.computeLiveEstimate(baseMessage);
        expect(estimate.isEnhancing).toBe(false);
        expect(estimate.totalAttempts).toBe(12);
        expect(estimate.attemptsLeft).toBe(10);
        expect(estimate.clearChance).toBeGreaterThan(0);
        expect(estimate.clearChance).toBeLessThanOrEqual(1);
    });

    test('percent-form success rates produce the same estimate as ratios', () => {
        const ratioEstimate = labyrinthClearRate.computeLiveEstimate(baseMessage);
        const percentEstimate = labyrinthClearRate.computeLiveEstimate({
            ...baseMessage,
            successRate: 80,
            doubleProgressChance: 10,
        });
        expect(percentEstimate.clearChance).toBeCloseTo(ratioEstimate.clearChance, 9);
    });

    test('detects enhancing rooms from targetLevel', () => {
        const estimate = labyrinthClearRate.computeLiveEstimate({
            ...baseMessage,
            targetLevel: 5,
            currentEnhLevel: 2,
            actionTimeMs: 8000,
        });
        expect(estimate.isEnhancing).toBe(true);
        expect(estimate.currentLevel).toBe(2);
        expect(estimate.targetLevel).toBe(5);
        expect(estimate.totalAttempts).toBe(15);
    });
});

describe('attachSkillingWhatIfs', () => {
    const buildBase = () => ({
        clearChance: 0.6,
        expectedSeconds: 90,
        xpPerRoom: 5000,
    });
    const metrics = { successBonus: 0, efficiencyBonus: 0.1, actionSpeedBonus: 0.05 };
    const params = {
        attempts: 12,
        successChance: 0.8,
        doubleChance: 0.05,
        levelBonus: 0,
        effectiveLevel: 110,
        progressPerSuccess: 121,
        targetProgress: 1000,
        roomLevel: 100,
    };

    test('adds what-if clear chances and XP/hour', () => {
        const result = buildBase();
        labyrinthClearRate.attachSkillingWhatIfs(result, metrics, params);

        expect(result.nextLevelClearChance).toBeGreaterThanOrEqual(0);
        expect(result.nextLevelClearChance).toBeLessThanOrEqual(1);
        expect(result.speedTierClearChance).toBeGreaterThanOrEqual(result.clearChance - 1e-9);
        expect(result.speedDelta).toBeGreaterThanOrEqual(0);
        // Time in the room, plus one second of travel to reach it. Retries
        // happen where you stand, so a room failed four times is still only
        // walked to once. Combat rooms are charged the same way.
        expect(result.xpPerHour).toBeCloseTo((5000 * 3600) / 91, 6);
    });

    test('efficiency tier reflects one fewer required progress unit', () => {
        const result = buildBase();
        labyrinthClearRate.attachSkillingWhatIfs(result, metrics, params);

        // 1000 target / 121 per success = 9 units needed; tier requires ceil(1000/8) = 125 per success
        expect(result.efficiencyDelta).toBeGreaterThan(0);
        expect(result.efficiencyTierClearChance).toBeGreaterThanOrEqual(0);
        expect(result.efficiencyTierClearChance).toBeLessThanOrEqual(1);
    });

    test('marks efficiency as optimal when one success clears the room', () => {
        const result = buildBase();
        labyrinthClearRate.attachSkillingWhatIfs(result, metrics, {
            ...params,
            progressPerSuccess: 1000,
            targetProgress: 1000,
        });
        expect(result.efficiencyDelta).toBeNull();
        expect(result.efficiencyTierClearChance).toBeNull();
    });
});

describe('computeLabyrinthPath', () => {
    // ASCII grids: S = cleared start, E = entrance, . = clearable,
    // X = unclearable (shroud), # = wall, T = treasure, F = floor exit
    function grid(rows) {
        const cols = rows[0].length;
        const tiles = [];
        for (const row of rows) {
            for (const ch of row) {
                if (ch === '#') {
                    tiles.push(null);
                    continue;
                }
                tiles.push({
                    cleared: ch === 'S',
                    isEntrance: ch === 'E',
                    needsShroud: ch === 'X',
                    isTreasure: ch === 'T',
                    isExit: ch === 'F',
                });
            }
        }
        return { tiles, cols };
    }

    test('routes straight to the exit', () => {
        const { tiles, cols } = grid(['S.F']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(0);
        expect(path.torches).toBe(2);
        expect([...path.route].sort()).toEqual([1, 2]);
    });

    test('detours around unclearable tiles instead of spending a shroud', () => {
        const { tiles, cols } = grid(['SXF', '...']);
        const path = computeLabyrinthPath(tiles, cols);
        // 0 shrouds via the bottom row (4 torches) beats 1 shroud (2 torches)
        expect(path.shrouds).toBe(0);
        expect(path.torches).toBe(4);
        expect(path.route.has(1)).toBe(false);
    });

    test('spends a shroud when the exit is walled off otherwise', () => {
        const { tiles, cols } = grid(['SXF', '###']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(1);
        expect(path.torches).toBe(2);
        expect(path.route.has(1)).toBe(true);
    });

    test('grafts on treasure rooms reachable without shrouds', () => {
        const { tiles, cols } = grid(['S.F', '#T#']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(0);
        expect(path.chests.size).toBe(1);
        expect(path.route.has(4)).toBe(true);
        expect(path.torches).toBe(3);
    });

    test('never spends a shroud to reach a chest', () => {
        const { tiles, cols } = grid(['S.F', '#X#', '#T#']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(0);
        expect(path.chests.size).toBe(0);
        expect(path.route.has(7)).toBe(false);
        expect(path.torches).toBe(2);
    });

    test('routes from an uncleared entrance on a fresh floor', () => {
        const { tiles, cols } = grid(['E.F']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(0);
        expect(path.torches).toBe(2);
    });

    test('returns null when no start or exit exists', () => {
        expect(computeLabyrinthPath(grid(['..F']).tiles, 3)).toBeNull();
        expect(computeLabyrinthPath(grid(['S..']).tiles, 3)).toBeNull();
    });
});

describe('computeBeaconPlan', () => {
    const manhattan = (a, b, cols) =>
        Math.abs((a % cols) - (b % cols)) + Math.abs(Math.floor(a / cols) - Math.floor(b / cols));

    test('chains the minimum beacons from entrance to exit on a dark floor', () => {
        const cols = 5;
        const revealed = new Array(25).fill(false);
        revealed[0] = true; // entrance
        const plan = computeBeaconPlan(revealed, cols, 0);

        expect(plan.feasible).toBe(true);
        expect(plan.minNeeded).toBe(2);
        expect(plan.beacons).toHaveLength(2);
        // First beacon reaches the entrance region, last reaches the exit,
        // consecutive reveal areas connect
        expect(manhattan(0, plan.beacons[0], cols)).toBeLessThanOrEqual(3);
        expect(manhattan(24, plan.beacons[1], cols)).toBeLessThanOrEqual(3);
        expect(manhattan(plan.beacons[0], plan.beacons[1], cols)).toBeLessThanOrEqual(5);
        expect(plan.revealedNew).toBeGreaterThan(0);
    });

    test('needs no beacons when a revealed corridor already exists', () => {
        const cols = 5;
        const revealed = new Array(25).fill(false);
        for (const idx of [0, 1, 2, 3, 4, 9, 14, 19, 24]) revealed[idx] = true;
        const plan = computeBeaconPlan(revealed, cols, 0);

        expect(plan.feasible).toBe(true);
        expect(plan.minNeeded).toBe(0);
        expect(plan.beacons).toHaveLength(0);
    });

    test('a count below the corridor minimum still gets a plan', () => {
        const cols = 5;
        const revealed = new Array(25).fill(false);
        revealed[0] = true;
        const plan = computeBeaconPlan(revealed, cols, 1);

        // One beacon cannot chain a covered path, but "where do I put the one
        // beacon I have" is still a question with an answer
        expect(plan.feasible).toBe(true);
        expect(plan.beacons).toHaveLength(1);
        expect(plan.revealedNew).toBeGreaterThan(0);
        expect(plan.corridorOpen).toBe(false);
        expect(plan.minNeeded).toBe(2);
    });

    test('a set count is planned for coverage even when the way out is already open', () => {
        const cols = 5;
        const revealed = new Array(25).fill(false);
        for (const idx of [0, 1, 2, 3, 4, 9, 14, 19, 24]) revealed[idx] = true;
        const plan = computeBeaconPlan(revealed, cols, 2);

        // The corridor being open is no reason to plan nothing — the rest of
        // the floor is still dark, and the beacons were already bought
        expect(plan.beacons).toHaveLength(2);
        expect(plan.revealedNew).toBeGreaterThan(0);
        expect(plan.corridorOpen).toBe(true);
        expect(plan.minNeeded).toBe(0);
    });

    test('more beacons reveal more rooms', () => {
        const cols = 5;
        const revealed = new Array(25).fill(false);
        revealed[0] = true;
        const two = computeBeaconPlan(revealed, cols, 2);
        const three = computeBeaconPlan(revealed, cols, 3);

        expect(three.feasible).toBe(true);
        expect(three.beacons).toHaveLength(3);
        expect(three.revealedNew).toBeGreaterThan(two.revealedNew);
    });

    test('places no more beacons than there are rooms left to reveal', () => {
        const cols = 5;
        const revealed = new Array(25).fill(true);
        revealed[12] = false; // one dark room in the middle
        const plan = computeBeaconPlan(revealed, cols, 6);

        expect(plan.beacons).toHaveLength(1);
        expect(plan.revealedNew).toBe(1);
    });

    test('two equally dark pockets, and the beacon lights the one on the way out', () => {
        const cols = 9;
        const idx = (x, y) => y * cols + x;
        const revealed = new Array(81).fill(true);
        const darken = (cx, cy) => {
            for (let y = 0; y < 9; y++) {
                for (let x = 0; x < 9; x++) {
                    if (Math.abs(x - cx) + Math.abs(y - cy) <= 2) revealed[idx(x, y)] = false;
                }
            }
        };
        darken(5, 6); // between the revealed floor and the exit at (8,8)
        darken(6, 2); // the same 13 rooms, but nothing out there is on the way

        const plan = computeBeaconPlan(revealed, cols, 1);
        expect(plan.revealedNew).toBe(13); // both pockets are worth the same
        expect(plan.beacons).toEqual([idx(5, 6)]);
    });
});

describe('countDisjointRoutes', () => {
    test('a single-file corridor is one route', () => {
        const cols = 5;
        const passable = new Array(25).fill(false);
        for (const idx of [0, 1, 2, 3, 4, 9, 14, 19, 24]) passable[idx] = true;
        expect(countDisjointRoutes(passable, cols)).toBe(1);
    });

    test('a fully open grid gives two corner-limited routes', () => {
        const passable = new Array(25).fill(true);
        expect(countDisjointRoutes(passable, 5)).toBe(2);
    });

    test('no passable cells means no route', () => {
        const passable = new Array(25).fill(false);
        expect(countDisjointRoutes(passable, 5)).toBe(0);
    });
});

describe('computeBeaconPlan route redundancy', () => {
    test('reports the route count without paying rooms for it', () => {
        const cols = 5;
        const revealed = new Array(25).fill(false);
        revealed[0] = true;
        const minimal = computeBeaconPlan(revealed, cols, 0);
        expect(minimal.routes).toBeGreaterThanOrEqual(1);

        const extra = computeBeaconPlan(revealed, cols, 4);
        expect(extra.feasible).toBe(true);
        expect(extra.revealedNew).toBeGreaterThanOrEqual(minimal.revealedNew);
    });
});

/**
 * combatCache is a plain Map that used to start empty on every reload. These
 * exercise the mirror written to the 'labyrinth' store — round-tripping
 * through it, dropping what TTL or a gear change make stale, and capping how
 * much of it survives.
 */
describe('persisted combat cache', () => {
    /** Replace the mocked loadoutSnapshot's gear in place, keeping the same object reference */
    function setGear(equipmentSnapshots) {
        for (const key of Object.keys(gear.snapshots)) delete gear.snapshots[key];
        Object.assign(gear.snapshots, equipmentSnapshots);
    }

    const sword = { equipment: [{ itemHrid: '/items/sword', enhancementLevel: 5 }] };
    const axe = { equipment: [{ itemHrid: '/items/axe', enhancementLevel: 0 }] };

    const simResult = (over = {}) => ({
        clearChance: 0.75,
        expectedSeconds: 12,
        type: 'combat',
        winRate: 0.75,
        trials: 500,
        monsterHrid: '/monsters/imp',
        roomLevel: 200,
        ...over,
    });

    beforeEach(() => {
        db.map.clear();
        setGear({ 1: sword });
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate._combatCacheMeta.clear();
        labyrinthClearRate._combatCacheLoaded = false;
        labyrinthClearRate._snapshotFingerprint = null;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('round-trips a fresh sim through storage and back into the Map', async () => {
        const key = 'imp:200:1:1pp:';
        const result = simResult();
        labyrinthClearRate.combatCache.set(key, result);
        labyrinthClearRate._persistCombatCacheEntry(key, result);

        // Simulate a reload: the in-memory Map starts empty again
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate._combatCacheMeta.clear();
        labyrinthClearRate._combatCacheLoaded = false;

        await labyrinthClearRate._loadCombatCache();

        const loaded = labyrinthClearRate.combatCache.get(key);
        expect(loaded).toMatchObject({ clearChance: 0.75, winRate: 0.75, fromPersistedCache: true });
        expect(Number.isFinite(loaded.computedAt)).toBe(true);
    });

    test('calling _loadCombatCache twice only reads storage once', async () => {
        const key = 'imp:200:1:1pp:';
        const result = simResult();
        labyrinthClearRate.combatCache.set(key, result);
        labyrinthClearRate._persistCombatCacheEntry(key, result);
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate._combatCacheLoaded = false;

        await labyrinthClearRate._loadCombatCache();
        expect(labyrinthClearRate.combatCache.has(key)).toBe(true);

        labyrinthClearRate.combatCache.clear();
        await labyrinthClearRate._loadCombatCache(); // guarded — should not re-read
        expect(labyrinthClearRate.combatCache.has(key)).toBe(false);
    });

    test('drops an entry older than the TTL', async () => {
        const key = 'imp:200:1:1pp:';
        const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
        db.map.set('labyrinth:labyrinthCombatSimCache', {
            version: 1,
            entries: [
                {
                    key,
                    result: simResult(),
                    computedAt: eightDaysAgo,
                    snapshotFingerprint: labyrinthClearRate._snapshotContentFingerprint(),
                },
            ],
        });

        await labyrinthClearRate._loadCombatCache();

        expect(labyrinthClearRate.combatCache.has(key)).toBe(false);
    });

    test('keeps an entry inside the TTL', async () => {
        const key = 'imp:200:1:1pp:';
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        db.map.set('labyrinth:labyrinthCombatSimCache', {
            version: 1,
            entries: [
                {
                    key,
                    result: simResult(),
                    computedAt: oneHourAgo,
                    snapshotFingerprint: labyrinthClearRate._snapshotContentFingerprint(),
                },
            ],
        });

        await labyrinthClearRate._loadCombatCache();

        expect(labyrinthClearRate.combatCache.get(key)).toMatchObject({ fromPersistedCache: true });
    });

    test('a gear change clears the persisted store, not just the in-memory Map', () => {
        const key = 'imp:200:1:1pp:';
        const result = simResult();

        // Seed the invalidation baseline under the sword, then persist a sim
        labyrinthClearRate._invalidateIfInputsChanged();
        labyrinthClearRate.combatCache.set(key, result);
        labyrinthClearRate._persistCombatCacheEntry(key, result);
        expect(db.map.get('labyrinth:labyrinthCombatSimCache').entries).toHaveLength(1);

        // Swap gear and re-check — this is the same path a real loadout
        // snapshot rebuild drives
        setGear({ 1: axe });
        const stale = labyrinthClearRate._invalidateIfInputsChanged();

        expect(stale).toBe(true);
        expect(labyrinthClearRate.combatCache.size).toBe(0);
        expect(db.map.get('labyrinth:labyrinthCombatSimCache').entries).toHaveLength(0);
    });

    test('a precision-only clear leaves the persisted store alone', () => {
        const key = 'imp:200:1:1pp:';
        const result = simResult();
        labyrinthClearRate._invalidateIfInputsChanged();
        labyrinthClearRate.combatCache.set(key, result);
        labyrinthClearRate._persistCombatCacheEntry(key, result);

        // Mirrors what the precision-input handler does: only the in-memory
        // Map is wiped, because a different mode simply uses a different key
        labyrinthClearRate.combatCache.clear();

        expect(db.map.get('labyrinth:labyrinthCombatSimCache').entries).toHaveLength(1);
    });

    test('caps the persisted set to the most recent entries', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 0, 1));

        const total = 205;
        for (let i = 0; i < total; i++) {
            const key = `imp:${i}:1:1pp:`;
            const result = simResult({ roomLevel: i });
            labyrinthClearRate.combatCache.set(key, result);
            labyrinthClearRate._persistCombatCacheEntry(key, result);
            vi.advanceTimersByTime(1000);
        }

        const stored = db.map.get('labyrinth:labyrinthCombatSimCache');
        expect(stored.entries).toHaveLength(200);
        expect(labyrinthClearRate._combatCacheMeta.size).toBe(200);

        // The newest 200 survive, not an arbitrary 200 — the earliest 5 keys
        // (imp:0 through imp:4) are the ones the cap should have pushed out
        const keys = new Set(stored.entries.map((e) => e.key));
        expect(keys.has('imp:0:1:1pp:')).toBe(false);
        expect(keys.has('imp:4:1:1pp:')).toBe(false);
        expect(keys.has('imp:204:1:1pp:')).toBe(true);
    });

    describe('cache age display', () => {
        beforeEach(() => {
            document.body.innerHTML = '';
        });

        test('cacheAgeLabel reads back a relative age', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
            const computedAt = Date.now() - 2 * 60 * 60 * 1000;
            expect(labyrinthClearRate.cacheAgeLabel(computedAt)).toBe('cached 2h 0m ago');
        });

        test('a fresh (non-persisted) result gets no age note', () => {
            const el = document.createElement('div');
            labyrinthClearRate._appendCacheAgeNote(el, simResult());
            expect(el.textContent).toBe('');
        });

        test('a persisted result gets a subtle one-line age note', () => {
            const el = document.createElement('div');
            labyrinthClearRate._appendCacheAgeNote(el, {
                ...simResult(),
                fromPersistedCache: true,
                computedAt: Date.now() - 60 * 60 * 1000,
            });
            expect(el.children).toHaveLength(1);
            expect(el.textContent).toContain('cached');
            expect(el.textContent).toContain('ago');
        });
    });
});

const { default: dataManagerMock } = await import('../../core/data-manager.js');

describe('guild buffs in skilling metrics', () => {
    const EFFICIENCY_SHRINE = {
        hrid: '/guild_buffs/force_skilling',
        isCombat: false,
        buffs: [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.02, flatBoostLevelBonus: 0.02 }],
    };

    beforeEach(() => {
        shrines.detailMap = { '/guild_buffs/force_skilling': EFFICIENCY_SHRINE };
        shrines.owned = { '/guild_buffs/force_skilling': 2 };
        dataManagerMock.characterData = {
            guildActionTypeBuffsMap: {
                '/action_types/milking': [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.04, ratioBoost: 0 }],
            },
        };
    });

    afterEach(() => {
        dataManagerMock.characterData = null;
    });

    test('the character’s live guild buffs are used when no levels are being explored', () => {
        const metrics = labyrinthClearRate.getSkillingMetricsFromOverrides('milking', '/action_types/milking', {});
        expect(metrics.efficiencyBonus).toBeCloseTo(0.04, 10);
    });

    test('a level the character already owns changes nothing — the server’s own numbers stand', () => {
        const metrics = labyrinthClearRate.getSkillingMetricsFromOverrides('milking', '/action_types/milking', {
            guildShrineLevels: { '/guild_buffs/force_skilling': 2 },
        });
        expect(metrics.efficiencyBonus).toBeCloseTo(0.04, 10);
    });

    test('a different level rebuilds that shrine, replacing rather than stacking', () => {
        const metrics = labyrinthClearRate.getSkillingMetricsFromOverrides('milking', '/action_types/milking', {
            guildShrineLevels: { '/guild_buffs/force_skilling': 3 },
        });
        // 0.02 × 3, in place of the 0.04 the server sent for level 2
        expect(metrics.efficiencyBonus).toBeCloseTo(0.06, 10);
    });

    test('a combat shrine is never applied to a skilling room', () => {
        shrines.detailMap['/guild_buffs/force_combat'] = {
            hrid: '/guild_buffs/force_combat',
            isCombat: true,
            buffs: [{ typeHrid: '/buff_types/efficiency', flatBoost: 5, flatBoostLevelBonus: 5 }],
        };
        const metrics = labyrinthClearRate.getSkillingMetricsFromOverrides('milking', '/action_types/milking', {
            guildShrineLevels: { '/guild_buffs/force_combat': 9 },
        });
        expect(metrics.efficiencyBonus).toBeCloseTo(0.04, 10);
    });
});

describe('equipment experience reaches a labyrinth room', () => {
    beforeEach(() => {
        for (const key of Object.keys(gear.snapshots)) delete gear.snapshots[key];
        gear.snapshots[3] = {
            equipment: [
                { itemHrid: '/items/philosophers_necklace', itemLocationHrid: '/item_locations/neck' },
                { itemHrid: '/items/celestial_shears', itemLocationHrid: '/item_locations/milking_tool' },
            ],
        };
        dataManagerMock.getInitClientData.mockReturnValue({
            itemDetailMap: {
                '/items/philosophers_necklace': {
                    equipmentDetail: { noncombatStats: { skillingExperience: 0.1 } },
                },
                '/items/celestial_shears': {
                    equipmentDetail: { noncombatStats: { milkingExperience: 0.05, milkingSpeed: 0.2 } },
                },
            },
            enhancementLevelTotalBonusMultiplierTable: {},
        });
    });

    afterEach(() => {
        dataManagerMock.getInitClientData.mockReturnValue(null);
        for (const key of Object.keys(gear.snapshots)) delete gear.snapshots[key];
    });

    test('wisdom and the skill charm come out as one wisdom buff', () => {
        const buffs = labyrinthClearRate.getLoadoutEquipmentBuffs(3, 'milking');
        const wisdom = buffs.find((b) => b.typeHrid === '/buff_types/wisdom');
        // 0.1 universal + 0.05 skill-specific, additive as everywhere else
        expect(wisdom.flatBoost).toBeCloseTo(0.15, 10);
    });

    test('applyBuff routes it to experienceBonus, so xpPerRoom sees it', () => {
        const metrics = { experienceBonus: 0 };
        for (const buff of labyrinthClearRate.getLoadoutEquipmentBuffs(3, 'milking')) {
            labyrinthClearRate.applyBuff(
                metrics,
                buff.typeHrid,
                (buff.flatBoost || 0) + (buff.ratioBoost || 0),
                '/buff_types/milking_level',
                '/buff_types/milking_success',
                'milking'
            );
        }
        expect(metrics.experienceBonus).toBeCloseTo(0.15, 10);
    });

    test('gear with no experience stat emits no wisdom buff at all', () => {
        gear.snapshots[3] = {
            equipment: [{ itemHrid: '/items/celestial_shears', itemLocationHrid: '/item_locations/milking_tool' }],
        };
        dataManagerMock.getInitClientData.mockReturnValue({
            itemDetailMap: {
                '/items/celestial_shears': { equipmentDetail: { noncombatStats: { milkingSpeed: 0.2 } } },
            },
            enhancementLevelTotalBonusMultiplierTable: {},
        });
        const buffs = labyrinthClearRate.getLoadoutEquipmentBuffs(3, 'milking');
        expect(buffs.some((b) => b.typeHrid === '/buff_types/wisdom')).toBe(false);
    });
});

describe('enhancing rooms report what they pay', () => {
    const metrics = {
        skillLevelBonus: 0,
        efficiencyBonus: 0,
        actionSpeedBonus: 0,
        successBonus: 0,
        doubleProgressBonus: 0,
        experienceBonus: 0,
    };

    test('xpPerRoom follows the same level × 50 award every other room type uses', () => {
        const result = labyrinthClearRate.computeEnhancingClearWithParams({ ...metrics }, 200, 100);
        expect(result.xpPerRoom).toBeCloseTo(100 * 50, 6);
    });

    test('wisdom raises it', () => {
        const result = labyrinthClearRate.computeEnhancingClearWithParams(
            { ...metrics, experienceBonus: 0.2 },
            200,
            100
        );
        expect(result.xpPerRoom).toBeCloseTo(100 * 50 * 1.2, 6);
    });

    test('a room that clears reports an hourly rate too, so it can be ranked', () => {
        const result = labyrinthClearRate.computeEnhancingClearWithParams({ ...metrics }, 200, 100);
        expect(result.clearChance).toBeGreaterThan(0);
        expect(result.xpPerHour).toBeGreaterThan(0);
    });
});

describe('official labyrinth skilling formulas', () => {
    const metrics = (over = {}) => ({
        skillLevelBonus: 0,
        efficiencyBonus: 0,
        actionSpeedBonus: 0,
        successBonus: 0,
        doubleProgressBonus: 0,
        gatheringBonus: 0,
        experienceBonus: 0,
        ...over,
    });

    const clear = (over, baseLevel, roomLevel) =>
        labyrinthClearRate.computeSkillingClearWithParams(metrics(over), baseLevel, roomLevel);

    describe('SkillingSuccessRate = MAX(5%, 0.80 × (1 + LevelBonus + Buffs))', () => {
        test('at the room level it is the flat 80%', () => {
            expect(clear({}, 100, 100).successChance).toBeCloseTo(0.8, 10);
        });

        test('every level above the room is worth +0.5%, not +1%', () => {
            // 20 over: 0.80 × (1 + 20 × 0.005) = 0.88
            expect(clear({}, 120, 100).successChance).toBeCloseTo(0.88, 10);
        });

        test('every level below the room costs −1%, twice what a level above pays', () => {
            // 20 under: 0.80 × (1 − 20 × 0.01) = 0.64
            expect(clear({}, 80, 100).successChance).toBeCloseTo(0.64, 10);
        });

        test('buffs add inside the bracket alongside the level bonus', () => {
            // 0.80 × (1 + 20 × 0.005 + 0.25) = 1.08 → capped at 100%
            expect(clear({ successBonus: 0.25 }, 120, 100).successChance).toBeCloseTo(1, 10);
            // 0.80 × (1 − 20 × 0.01 + 0.25) = 0.84
            expect(clear({ successBonus: 0.25 }, 80, 100).successChance).toBeCloseTo(0.84, 10);
        });

        test('the 5% floor holds however far under the room you are', () => {
            // 0.80 × (1 − 200 × 0.01) = −0.80, which is not what the game does
            expect(clear({}, 1, 201).successChance).toBeCloseTo(0.05, 10);
            expect(clear({}, 50, 500).successChance).toBeCloseTo(0.05, 10);
        });

        test('a level bonus that lands just above the floor is not raised to it', () => {
            // 0.80 × (1 − 93 × 0.01) = 0.056, above the 5% floor and left alone
            expect(clear({}, 7, 100).successChance).toBeCloseTo(0.056, 10);
        });
    });

    describe('WorkPower = EffectiveLevel × (1 + Efficiency)', () => {
        test('efficiency multiplies the effective level, and progress is its floor', () => {
            const result = clear({ efficiencyBonus: 0.37 }, 100, 80);
            expect(result.workPower).toBeCloseTo(137, 10);
            expect(result.progressPerSuccess).toBe(137);
        });

        test('a level buff feeds effective level, so it lands inside the product', () => {
            const result = clear({ skillLevelBonus: 15, efficiencyBonus: 0.1 }, 100, 80);
            expect(result.effectiveLevel).toBe(115);
            expect(result.workPower).toBeCloseTo(126.5, 10);
            // Progress per success is whole, so 126.5 spends as 126
            expect(result.progressPerSuccess).toBe(126);
        });

        test('the room asks for RoomLevel × 10 progress', () => {
            expect(clear({}, 100, 80).targetProgress).toBe(800);
        });
    });

    describe('DoubleProgress = Crate + Gathering + Upgrade', () => {
        const applyGathering = (skillId) => {
            const m = { doubleProgressBonus: 0, gatheringBonus: 0, experienceBonus: 0, successBonus: 0 };
            labyrinthClearRate.applyBuff(
                m,
                '/buff_types/gathering',
                0.15,
                `/buff_types/${skillId}_level`,
                `/buff_types/${skillId}_success`,
                skillId
            );
            return m;
        };

        test('the gathering buff counts in the three gathering skills', () => {
            for (const skillId of ['milking', 'foraging', 'woodcutting']) {
                expect(applyGathering(skillId).gatheringBonus).toBeCloseTo(0.15, 10);
            }
        });

        test('it does not count anywhere else — cheesesmithing has no gathering quantity', () => {
            for (const skillId of ['cheesesmithing', 'cooking', 'brewing', 'tailoring']) {
                expect(applyGathering(skillId).gatheringBonus).toBe(0);
            }
        });

        test('the crate and upgrade terms add to the gathering one', () => {
            expect(clear({ doubleProgressBonus: 0.2, gatheringBonus: 0.15 }, 100, 80).doubleChance).toBeCloseTo(
                0.35,
                10
            );
        });
    });

    describe('Experience = RoomLevel × 50', () => {
        test('a skilling room pays its own level, not the character’s', () => {
            expect(clear({}, 250, 80).xpPerRoom).toBeCloseTo(4000, 6);
        });

        test('an enhancing room uses the identical formula', () => {
            const enhancing = labyrinthClearRate.computeEnhancingClearWithParams(metrics(), 250, 80);
            expect(enhancing.xpPerRoom).toBeCloseTo(4000, 6);
        });
    });
});

describe('expected token and box rows', () => {
    /** Collect the rows appendExpectedRows produces */
    function rows(result) {
        const collected = [];
        labyrinthClearRate.appendExpectedRows((label, value, title) => collected.push({ label, value, title }), result);
        return collected;
    }

    afterEach(() => {
        labyrinthClearRate.currentFloor = 0;
    });

    test('a challenge room you always clear is worth the full drop rate', () => {
        labyrinthClearRate.currentFloor = 4;
        const [token, box] = rows({ type: 'combat', clearChance: 1 });
        expect(token.value).toBe('0.20');
        expect(box.value).toBe('0.04');
        expect(box.label).toBe('Combat Box Expected');
    });

    test('a room you clear a quarter of the time is worth a quarter of it', () => {
        labyrinthClearRate.currentFloor = 4;
        const [token, box] = rows({ type: 'skilling', clearChance: 0.25 });
        expect(token.value).toBe('0.05');
        expect(box.value).toBe('0.01');
        expect(box.label).toBe('Skilling Box Expected');
    });

    test('the rates cite the official rule, and the weighting is explained', () => {
        labyrinthClearRate.currentFloor = 4;
        const [token] = rows({ type: 'combat', clearChance: 0.5 });
        expect(token.title).toContain('MIN(Floor × 5%, 50%)');
        expect(token.title).toContain('50% clear chance');
    });

    test('a caller with no clear chance gets the unweighted rate rather than nothing', () => {
        labyrinthClearRate.currentFloor = 4;
        const [token] = rows('combat');
        expect(token.value).toBe('0.20');
    });

    test('a treasure room pays its whole table — no clear is asked of you', () => {
        labyrinthClearRate.currentFloor = 6;
        const [token, skilling, combat] = rows({ type: 'treasure', clearChance: 0.25 });
        expect(token.value).toBe('6.00');
        expect(skilling.label).toBe('Skilling Box Expected');
        expect(skilling.value).toBe('0.30');
        expect(combat.label).toBe('Combat Box Expected');
        expect(combat.value).toBe('0.30');
    });

    test('the floor exit pays tokens, both boxes and a refinement chest', () => {
        labyrinthClearRate.currentFloor = 8;
        const [token, skilling, combat, chest] = rows({ type: 'exit' });
        expect(token.value).toBe('40.00');
        expect(skilling.value).toBe('2.50');
        expect(combat.value).toBe('2.50');
        expect(chest.label).toBe('Refinement Chest Expected');
        expect(chest.value).toBe('2.00');
    });

    test('floor 0 has no rewards to expect', () => {
        labyrinthClearRate.currentFloor = 0;
        expect(rows({ type: 'combat', clearChance: 1 })).toHaveLength(0);
    });
});

describe('official labyrinth reward tables', () => {
    test('a challenge room rolls MIN(Floor × 5%, 50%) for a token, capped from floor 10', () => {
        expect(labyrinthRoomRewards(1, 'combat').tokens).toBeCloseTo(0.05, 10);
        expect(labyrinthRoomRewards(7, 'skilling').tokens).toBeCloseTo(0.35, 10);
        expect(labyrinthRoomRewards(10, 'combat').tokens).toBeCloseTo(0.5, 10);
        expect(labyrinthRoomRewards(25, 'combat').tokens).toBeCloseTo(0.5, 10);
    });

    test("a challenge room rolls MIN(Floor × 1%, 10%) for a Purdora's Box of its own kind", () => {
        const combat = labyrinthRoomRewards(7, 'combat');
        expect(combat.combatBoxes).toBeCloseTo(0.07, 10);
        expect(combat.skillingBoxes).toBe(0);

        // Enhancing rooms are skilling rooms, so they pay the Skilling box
        for (const kind of ['skilling', 'enhancing']) {
            const skilling = labyrinthRoomRewards(7, kind);
            expect(skilling.skillingBoxes).toBeCloseTo(0.07, 10);
            expect(skilling.combatBoxes).toBe(0);
        }

        expect(labyrinthRoomRewards(10, 'combat').combatBoxes).toBeCloseTo(0.1, 10);
        expect(labyrinthRoomRewards(30, 'combat').combatBoxes).toBeCloseTo(0.1, 10);
    });

    test('a treasure room always pays MIN(Floor, 10) tokens', () => {
        expect(labyrinthRoomRewards(3, 'treasure').tokens).toBe(3);
        expect(labyrinthRoomRewards(10, 'treasure').tokens).toBe(10);
        expect(labyrinthRoomRewards(14, 'treasure').tokens).toBe(10);
    });

    test('a treasure room rolls MIN(Floor × 5%, 50%) for one box of each type', () => {
        const mid = labyrinthRoomRewards(6, 'treasure');
        expect(mid.skillingBoxes).toBeCloseTo(0.3, 10);
        expect(mid.combatBoxes).toBeCloseTo(0.3, 10);

        const capped = labyrinthRoomRewards(12, 'treasure');
        expect(capped.skillingBoxes).toBeCloseTo(0.5, 10);
        expect(capped.combatBoxes).toBeCloseTo(0.5, 10);
    });

    test('the floor exit always pays 5 × Floor tokens', () => {
        expect(labyrinthRoomRewards(1, 'exit').tokens).toBe(5);
        expect(labyrinthRoomRewards(9, 'exit').tokens).toBe(45);
    });

    test('the floor exit pays both box types from floor 4, averaging (Floor − 3) / 2 each', () => {
        expect(labyrinthRoomRewards(3, 'exit').skillingBoxes).toBe(0);
        expect(labyrinthRoomRewards(3, 'exit').combatBoxes).toBe(0);

        expect(labyrinthRoomRewards(4, 'exit').skillingBoxes).toBeCloseTo(0.5, 10);
        expect(labyrinthRoomRewards(4, 'exit').combatBoxes).toBeCloseTo(0.5, 10);
        expect(labyrinthRoomRewards(9, 'exit').skillingBoxes).toBeCloseTo(3, 10);
        expect(labyrinthRoomRewards(9, 'exit').combatBoxes).toBeCloseTo(3, 10);
    });

    test('the floor exit pays a Refinement Chest from floor 6, averaging (Floor − 4) / 2', () => {
        expect(labyrinthRoomRewards(5, 'exit').refinementChests).toBe(0);
        expect(labyrinthRoomRewards(6, 'exit').refinementChests).toBeCloseTo(1, 10);
        expect(labyrinthRoomRewards(9, 'exit').refinementChests).toBeCloseTo(2.5, 10);
    });

    test('nothing drops below floor 1', () => {
        for (const kind of ['combat', 'skilling', 'treasure', 'exit']) {
            expect(labyrinthRoomRewards(0, kind)).toEqual({
                tokens: 0,
                skillingBoxes: 0,
                combatBoxes: 0,
                refinementChests: 0,
            });
        }
    });
});

describe('labyrinthGridSize', () => {
    test('a floor is MIN(3 + Floor, 8) rooms per side', () => {
        expect(labyrinthGridSize(1)).toBe(4);
        expect(labyrinthGridSize(4)).toBe(7);
        expect(labyrinthGridSize(5)).toBe(8);
        expect(labyrinthGridSize(12)).toBe(8);
    });

    test('there is no grid below floor 1', () => {
        expect(labyrinthGridSize(0)).toBe(0);
        expect(labyrinthGridSize(null)).toBe(0);
    });
});

describe('effective combat level', () => {
    const skillList = (over = {}) => {
        const levels = { stamina: 100, intelligence: 100, attack: 100, defense: 100, melee: 100, ...over };
        return Object.entries(levels).map(([name, level]) => ({ skillHrid: `/skills/${name}`, level }));
    };

    beforeEach(() => {
        dataManagerMock.getSkills.mockReturnValue(skillList());
        dataManagerMock.characterData = null;
        dataManagerMock.getInitClientData.mockReturnValue(null);
    });

    afterEach(() => {
        dataManagerMock.getSkills.mockReturnValue([]);
        dataManagerMock.getInitClientData.mockReturnValue(null);
        dataManagerMock.characterData = null;
    });

    test('falls back to the game’s own formula rather than a hardcoded 100', () => {
        // 0.1 × (100 × 5) + 0.5 × 100 = 100 for this build; make it not-100 so
        // a surviving constant would be visible
        dataManagerMock.getSkills.mockReturnValue(skillList({ melee: 60, attack: 60, defense: 60 }));
        // 0.1 × (100 + 100 + 60 + 60 + 60) + 0.5 × 60 = 38 + 30 = 68
        expect(labyrinthClearRate.getPlayerEffectiveCombatLevel()).toBe(68);
    });

    test('the server’s figure wins when it is there', () => {
        dataManagerMock.characterData = { combatUnit: { combatDetails: { combatLevel: 137.4 } } };
        expect(labyrinthClearRate.getPlayerEffectiveCombatLevel()).toBe(137);
    });

    test('no character data at all gives null, not an invented level', () => {
        dataManagerMock.getSkills.mockReturnValue([]);
        expect(labyrinthClearRate.getPlayerEffectiveCombatLevel()).toBeNull();
    });

    test('a crate’s per-skill levels are weighted by the formula, not averaged', () => {
        dataManagerMock.characterData = {
            characterLabyrinth: { coffeeCrateItemHrid: '/items/crate' },
            combatUnit: { combatDetails: { combatLevel: 100 } },
        };
        dataManagerMock.getInitClientData.mockReturnValue({
            labyrinthCrateDetailMap: {
                '/items/crate': [
                    { typeHrid: '/buff_types/melee_level', flatBoost: 10, ratioBoost: 0 },
                    { typeHrid: '/buff_types/stamina_level', flatBoost: 10, ratioBoost: 0 },
                ],
            },
        });
        // Melee carries the doubled term (0.6 each) and stamina only the flat
        // one (0.1 each): 6 + 1 = 7. Averaging the two +10s gave 10.
        expect(labyrinthClearRate.getPlayerEffectiveCombatLevel()).toBeCloseTo(107, 6);
    });

    test('a direct combat_level buff still moves it one-for-one', () => {
        dataManagerMock.characterData = {
            characterLabyrinth: { coffeeCrateItemHrid: '/items/crate' },
            combatUnit: { combatDetails: { combatLevel: 100 } },
        };
        dataManagerMock.getInitClientData.mockReturnValue({
            labyrinthCrateDetailMap: {
                '/items/crate': [{ typeHrid: '/buff_types/combat_level', flatBoost: 5, ratioBoost: 0 }],
            },
        });
        expect(labyrinthClearRate.getPlayerEffectiveCombatLevel()).toBeCloseTo(105, 6);
    });
});

describe('the recommend panel’s target win %', () => {
    beforeEach(() => {
        settings.map.clear();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
        settings.map.clear();
    });

    test('reading it writes it back, so it survives a reload like the path panel’s does', () => {
        document.body.innerHTML = '<input id="mwi-recommend-target-rate" value="88">';
        expect(labyrinthClearRate.getRecommendTargetPct()).toBe(88);
        expect(settings.map.get('labyrinthRecommendTargetRate')).toBe(88);
    });

    test('an out-of-range entry is clamped in the field as well as in the answer', () => {
        document.body.innerHTML = '<input id="mwi-recommend-target-rate" value="480">';
        expect(labyrinthClearRate.getRecommendTargetPct()).toBe(100);
        expect(document.getElementById('mwi-recommend-target-rate').value).toBe('100');
    });

    test('an empty field falls back to the stored setting, not to a constant', () => {
        settings.map.set('labyrinthRecommendTargetRate', 55);
        document.body.innerHTML = '<input id="mwi-recommend-target-rate" value="">';
        expect(labyrinthClearRate.getRecommendTargetPct()).toBe(55);
    });

    test('with nothing stored at all it uses the schema default', () => {
        document.body.innerHTML = '';
        expect(labyrinthClearRate.getRecommendTargetPct()).toBe(70);
    });
});

describe('a recommend run keeps the combat cache', () => {
    beforeEach(() => {
        db.map.clear();
        settings.map.clear();
        document.body.innerHTML = '';
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate._combatCacheMeta.clear();
        labyrinthClearRate.recommendRunning = false;
    });

    afterEach(() => {
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate._combatCacheMeta.clear();
        document.body.innerHTML = '';
    });

    test('sims read back off disk survive pressing Recommend', async () => {
        const key = 'imp:200:1:1pp:';
        labyrinthClearRate.combatCache.set(key, { clearChance: 0.8, expectedSeconds: 10, type: 'combat' });

        // No room cells in the document, so the run finds nothing to do — the
        // question is only what it destroys on the way in
        await labyrinthClearRate.runRecommendations();

        expect(labyrinthClearRate.combatCache.has(key)).toBe(true);
    });
});
