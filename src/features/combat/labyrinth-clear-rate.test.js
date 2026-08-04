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

/** The mocked inventory the supply reader sees */
const bag = vi.hoisted(() => ({ items: null }));

/** What the mocked marketplace client knows */
const market = vi.hoisted(() => ({ loaded: false, prices: {} }));

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
        getCurrentCharacterId: vi.fn(() => 'me'),
        getCurrentCharacterGameMode: vi.fn(() => 'standard'),
        getSkills: vi.fn(() => []),
        getInitClientData: vi.fn(() => null),
        getCharacterGuildBuffLevel: (hrid) => shrines.owned[hrid] || 0,
        getInventory: () => bag.items,
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
// The supply planner asks the market what a missing shroud would cost. Importing
// the real client drags in the socket connection state, which is a lot of
// machinery for a note that these suites never assert on.
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => market.loaded, getPrice: (hrid) => market.prices[hrid] || null },
}));
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
const dbGet = async (key, storeName = 'settings', defaultValue = null) => {
    const stored = db.map.get(`${storeName}:${key}`);
    return stored === undefined || stored === null ? defaultValue : stored;
};
const dbSet = async (key, value, storeName = 'settings') => {
    db.map.set(`${storeName}:${key}`, value);
    return true;
};

vi.mock('../../core/storage.js', () => ({
    default: {
        get: dbGet,
        getJSON: dbGet,
        set: dbSet,
        setJSON: dbSet,
        delete: async (key, storeName = 'settings') => db.map.delete(`${storeName}:${key}`),
        getAllKeys: async () => [],
    },
}));

const { default: labyrinthClearRate } = await import('./labyrinth-clear-rate.js');

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
        db.map.set('labyrinth:labyrinthCombatSimCache_me', {
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
        db.map.set('labyrinth:labyrinthCombatSimCache_me', {
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
        expect(db.map.get('labyrinth:labyrinthCombatSimCache_me').entries).toHaveLength(1);

        // Swap gear and re-check — this is the same path a real loadout
        // snapshot rebuild drives
        setGear({ 1: axe });
        const stale = labyrinthClearRate._invalidateIfInputsChanged();

        expect(stale).toBe(true);
        expect(labyrinthClearRate.combatCache.size).toBe(0);
        expect(db.map.get('labyrinth:labyrinthCombatSimCache_me').entries).toHaveLength(0);
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

        expect(db.map.get('labyrinth:labyrinthCombatSimCache_me').entries).toHaveLength(1);
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

        const stored = db.map.get('labyrinth:labyrinthCombatSimCache_me');
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

describe('per-character fight outcomes', () => {
    beforeEach(() => {
        db.map.clear();
        labyrinthClearRate._outcomes = {};
        labyrinthClearRate._outcomesSeen = {};
        labyrinthClearRate._baseline = null;
        labyrinthClearRate._outcomesLoaded = false;
    });

    test('outcomes are written under this character’s key', async () => {
        labyrinthClearRate._outcomes = { '/monsters/imp:200': { wins: 3, fights: 4 } };
        await labyrinthClearRate.saveOutcomes();

        expect(db.map.has('settings:labyrinthFightOutcomes_me')).toBe(true);
        expect(db.map.has('settings:labyrinthFightOutcomes')).toBe(false);
    });

    test('a load reads only this character’s record', async () => {
        db.map.set('settings:labyrinthFightOutcomes_me', {
            version: 2,
            totals: { mine: { wins: 1, fights: 1 } },
        });
        db.map.set('settings:labyrinthFightOutcomes_other', {
            version: 2,
            totals: { theirs: { wins: 9, fights: 9 } },
        });

        await labyrinthClearRate.loadOutcomes();

        expect(labyrinthClearRate._outcomes).toEqual({ mine: { wins: 1, fights: 1 } });
    });

    test('a legacy global record is discarded rather than inherited', async () => {
        // A win rate is a measurement of one character's power against a room.
        // Handing it to another character would poison every verdict from there
        // on, so the pre-scoping value is dropped and counting starts again.
        db.map.set('settings:labyrinthFightOutcomes', {
            version: 2,
            totals: { '/monsters/imp:200': { wins: 40, fights: 40 } },
        });

        await labyrinthClearRate.loadOutcomes();

        expect(labyrinthClearRate._outcomes).toEqual({});
        expect(db.map.has('settings:labyrinthFightOutcomes')).toBe(false);
        expect(db.map.has('settings:labyrinthFightOutcomes_me')).toBe(false);
    });

    test('the legacy combat sim cache is discarded too', async () => {
        db.map.set('labyrinth:labyrinthCombatSimCache', {
            version: 1,
            entries: [{ key: 'imp:200:1:1pp:', result: {}, computedAt: Date.now(), snapshotFingerprint: 'x' }],
        });
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate._combatCacheMeta.clear();
        labyrinthClearRate._combatCacheLoaded = false;

        await labyrinthClearRate._loadCombatCache();

        expect(labyrinthClearRate.combatCache.size).toBe(0);
        expect(db.map.has('labyrinth:labyrinthCombatSimCache')).toBe(false);
    });
});

/**
 * The one thing splitting the module into mixins newly makes possible to get
 * wrong: a method group that never reaches the prototype, or two groups that
 * both claim a name and silently overwrite one another. Neither shows up in an
 * arithmetic test — the call just lands on `undefined`, or on the wrong body.
 */
const { outcomeMethods } = await import('./labyrinth-outcomes.js');
const { simCacheMethods } = await import('./labyrinth-sim-cache.js');
const { recommendationMethods } = await import('./labyrinth-recommendation.js');

describe('the mixin groups reach the singleton intact', () => {
    test('every method each group exports is callable on the singleton', () => {
        const groups = { outcomes: outcomeMethods, simCache: simCacheMethods, recommendation: recommendationMethods };

        for (const [name, methods] of Object.entries(groups)) {
            const missing = Object.keys(methods).filter((key) => typeof labyrinthClearRate[key] !== 'function');
            expect(`${name}: ${missing.join(', ')}`).toBe(`${name}: `);
        }
    });

    test('no two groups claim the same method name', () => {
        const groups = [outcomeMethods, simCacheMethods, recommendationMethods];

        const seen = new Set();
        const clashes = [];
        for (const methods of groups) {
            for (const key of Object.keys(methods)) {
                if (seen.has(key)) clashes.push(key);
                seen.add(key);
            }
        }
        expect(clashes).toEqual([]);
    });

    test('the class body keeps its own methods — nothing was assigned over them', () => {
        // A group that grew a name the entry module already defines would win
        // the Object.assign and quietly replace the panel's own version
        const groupKeys = new Set([
            ...Object.keys(outcomeMethods),
            ...Object.keys(simCacheMethods),
            ...Object.keys(recommendationMethods),
        ]);
        for (const key of ['initialize', 'disable', 'injectOverlays', 'computeSkillingClear', 'buildResult']) {
            expect(typeof labyrinthClearRate[key]).toBe('function');
            expect(groupKeys.has(key)).toBe(false);
        }
    });
});

/**
 * The planners used to answer as though the shop were free: a floor could be
 * told it needed thirteen shrouds while two sat in the bag, with nothing said.
 * These drive the real planner methods over a fixture grid and read the status
 * line they leave behind.
 */
describe('planning against the supplies actually held', () => {
    const supplyItem = (itemHrid, count) => ({
        itemHrid,
        count,
        enhancementLevel: 0,
        itemLocationHrid: '/item_locations/inventory',
    });

    /** A square grid of unrevealed rooms, plus the toolbar the planners write to */
    function buildGrid(side) {
        document.body.innerHTML = '';
        const parent = document.createElement('div');
        for (let i = 0; i < side * side; i++) {
            const cell = document.createElement('div');
            cell.className = 'LabyrinthPanel_roomCell_abc';
            parent.appendChild(cell);
        }
        document.body.appendChild(parent);

        const status = document.createElement('span');
        status.className = 'mwi-labyrinth-tile-controls-status';
        document.body.appendChild(status);

        labyrinthClearRate.roomData = Array.from({ length: side }, () => new Array(side).fill(null));
        labyrinthClearRate.currentFloor = 5;
        return status;
    }

    const beaconInput = (value) => {
        const input = document.createElement('input');
        input.className = 'mwi-labyrinth-tile-controls-beacon-count';
        input.value = String(value);
        document.body.appendChild(input);
        return input;
    };

    beforeEach(() => {
        settings.map.clear();
        market.loaded = false;
        market.prices = {};
        bag.items = [
            supplyItem('/items/expert_torch', 43),
            supplyItem('/items/expert_shroud', 2),
            supplyItem('/items/advanced_beacon', 3),
        ];
    });

    afterEach(() => {
        document.body.innerHTML = '';
        labyrinthClearRate.roomData = null;
        bag.items = null;
    });

    test('reads the held counts off the inventory', () => {
        expect(labyrinthClearRate.getSupplyCounts()).toMatchObject({ torch: 43, shroud: 2, beacon: 3, known: true });
    });

    test('a path needing more shrouds than are held says so instead of just counting', async () => {
        const status = buildGrid(4);

        await labyrinthClearRate.runPathCalculation();

        // Every unrevealed room on the route costs a shroud under the default
        // ? mode, which is exactly how a two-shroud bag meets a five-shroud plan
        expect(status.textContent).toMatch(/\d+ shrouds needed · 2 owned/);
        expect(status.style.color).toBe('#ff8a80');
    });

    test('a path it can afford is not nagged about supplies', async () => {
        bag.items = [supplyItem('/items/expert_torch', 43), supplyItem('/items/expert_shroud', 99)];
        const status = buildGrid(4);

        await labyrinthClearRate.runPathCalculation();

        expect(status.textContent).not.toContain('owned');
        expect(status.style.color).toBe('');
    });

    test('the shortfall separates confirmed shrouds from ones the ? mode assumed', async () => {
        const status = buildGrid(4);

        await labyrinthClearRate.runPathCalculation();

        expect(status.textContent).toContain('assumed for unrevealed rooms');
    });

    test('a buy hint is added only when the market has a price', async () => {
        const status = buildGrid(4);
        await labyrinthClearRate.runPathCalculation();
        expect(status.textContent).not.toContain('at ask');

        market.loaded = true;
        market.prices = { '/items/basic_shroud': { ask: 1000 } };
        await labyrinthClearRate.runPathCalculation();
        expect(status.textContent).toContain('basic shroud');
        expect(status.textContent).toContain('at ask');
    });

    test('four beacons set against three owned plans three and shows both numbers', () => {
        const status = buildGrid(6);
        const input = beaconInput(4);

        labyrinthClearRate.runBeaconCalculation();

        expect(status.textContent).toContain('(4 set / 3 owned)');
        // The field keeps the request — it is the user's setting, not a reading
        // of the bag, and clamping it would lose it as beacons are spent
        expect(input.value).toBe('4');
        expect(document.querySelectorAll('[data-beacon-center="1"]')).toHaveLength(3);
    });

    test('owning none degrades to saying so rather than drawing a plan', () => {
        bag.items = [supplyItem('/items/expert_torch', 43)];
        const status = buildGrid(6);
        beaconInput(4);

        labyrinthClearRate.runBeaconCalculation();

        expect(status.textContent).toBe('No beacons owned — 4 set / 0 owned');
        expect(document.querySelectorAll('[data-beacon-center="1"]')).toHaveLength(0);
    });

    test('an unreadable inventory plans what was asked for rather than inventing a limit', () => {
        bag.items = null;
        const status = buildGrid(6);
        beaconInput(4);

        labyrinthClearRate.runBeaconCalculation();

        expect(status.textContent).not.toContain('owned');
        expect(document.querySelectorAll('[data-beacon-center="1"]')).toHaveLength(4);
    });
});

/**
 * The live readout on the attempt bar, driven through the real battle_updated
 * path. The reported symptom — a percentage that "changes wildly till I open
 * the lab room tab" — had two causes, and both are checked here: the room the
 * fight is in was only knowable once a labyrinth_updated message had landed,
 * and the fallback estimate was quoted as a point figure it had not earned.
 */
describe('the live clear chance on the attempt bar', () => {
    const LIVE_SELECTOR = '.mwi-labyrinth-live-combat';

    /** The action bar the game draws for a labyrinth fight */
    function buildActionBar(text = 'Labyrinth - Mimic Lv.245') {
        document.body.innerHTML = '';
        const row = document.createElement('div');
        row.className = 'Header_actionName_x';
        const name = document.createElement('div');
        name.className = 'Header_displayName_x';
        name.textContent = text;
        row.appendChild(name);
        document.body.appendChild(row);
        return row;
    }

    /** One battle_updated tick: fractions of max, and the attack counter */
    const tick = (monsterFraction, playerFraction, atkCounter) => ({
        battleId: 'b1',
        pMap: { 0: { cHP: Math.round(1000 * playerFraction), mHP: 1000, cMP: 500, mMP: 500, atkCounter } },
        mMap: { 0: { cHP: Math.round(2000 * monsterFraction), mHP: 2000 } },
    });

    const liveText = () => document.querySelector(LIVE_SELECTOR)?.textContent || '';

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
        settings.map.clear();
        atk = 0;
        labyrinthClearRate._fight = null;
        labyrinthClearRate._replay = null;
        labyrinthClearRate._liveCombatDrawnAt = 0;
        labyrinthClearRate.roomData = null;
        labyrinthClearRate._pathData = null;
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
        labyrinthClearRate._fight = null;
        labyrinthClearRate._replay = null;
        labyrinthClearRate._liveCombatDrawnAt = 0;
        labyrinthClearRate.roomData = null;
        labyrinthClearRate._pathData = null;
    });

    /**
     * Advance the fight, drawing a tick a second. The attack counter runs
     * across calls — a counter that went backwards is how a *new* fight is
     * detected, so restarting it would silently begin a fresh attempt.
     */
    let atk = 0;
    function runTicks(fractions) {
        for (const [monsterFraction, playerFraction] of fractions) {
            vi.advanceTimersByTime(1000);
            labyrinthClearRate._liveCombatDrawnAt = 0; // past the once-a-second draw throttle
            labyrinthClearRate.onBattleUpdated(tick(monsterFraction, playerFraction, ++atk));
        }
    }

    test('a fight whose evidence is thin is shown as a band, not a swinging figure', () => {
        buildActionBar();

        // Lumpy damage over the first few seconds: the underlying extrapolation
        // moves a long way between blows, which is exactly what was on screen
        const shown = [];
        const lumpy = [
            [0.98, 0.99],
            [0.97, 0.95],
            [0.8, 0.94],
            [0.79, 0.8],
            [0.62, 0.79],
            [0.61, 0.62],
            [0.5, 0.61],
            [0.49, 0.5],
            [0.44, 0.49],
            [0.43, 0.44],
        ];
        for (const step of lumpy) {
            runTicks([step]);
            const text = liveText();
            if (text) shown.push(text.replace(/\|.*$/, '').trim());
        }

        expect(shown.length).toBeGreaterThan(2);

        // Never a point figure: a chance the fight has not earned is not quoted
        // to the percentage point in either direction
        for (const text of shown) {
            expect(text).toMatch(/^\[Clear \d+–\d+%\?\]$/);
        }

        // And it never jumps. The readings underneath went 82% → 52% → 67% →
        // 52% across those four seconds — a 30-point swing between consecutive
        // ticks — and the display moves by at most one band
        const lows = shown.map((text) => Number(/Clear (\d+)–/.exec(text)[1]));
        for (let i = 1; i < lows.length; i++) {
            expect(Math.abs(lows[i] - lows[i - 1])).toBeLessThanOrEqual(25);
        }
        expect(new Set(shown).size).toBeLessThanOrEqual(2);
    });

    test('the room is identified from the action bar before any labyrinth message lands', () => {
        buildActionBar();
        dataManagerMock.getInitClientData.mockReturnValue({
            combatMonsterDetailMap: { '/monsters/mimic': { name: 'Mimic' } },
        });

        // No roomData and no pathData — the state a page reloaded mid-fight is in
        expect(labyrinthClearRate.roomData).toBeNull();
        expect(labyrinthClearRate.liveRoomContext()).toEqual({
            monsterHrid: '/monsters/mimic',
            roomLevel: 245,
            source: 'header',
        });

        dataManagerMock.getInitClientData.mockReturnValue(null);
    });

    test('once the grid is known it is the authority, not the header', () => {
        buildActionBar('Labyrinth - Mimic Lv.245');
        dataManagerMock.getInitClientData.mockReturnValue({
            combatMonsterDetailMap: { '/monsters/mimic': { name: 'Mimic' } },
        });
        labyrinthClearRate.roomData = [[{ monsterHrid: '/monsters/imp', recommendedLevel: 200 }]];
        labyrinthClearRate._pathData = [{ x: 0, y: 0 }];

        expect(labyrinthClearRate.liveRoomContext()).toEqual({
            monsterHrid: '/monsters/imp',
            roomLevel: 200,
            source: 'grid',
        });

        dataManagerMock.getInitClientData.mockReturnValue(null);
    });

    test('a monster the data has never heard of yields no context rather than a guess', () => {
        buildActionBar('Labyrinth - Something Else Lv.99');
        dataManagerMock.getInitClientData.mockReturnValue({
            combatMonsterDetailMap: { '/monsters/mimic': { name: 'Mimic' } },
        });

        expect(labyrinthClearRate.liveRoomContext()).toBeNull();

        dataManagerMock.getInitClientData.mockReturnValue(null);
    });

    test('a replayed figure replaces the band once one is in hand', () => {
        buildActionBar();
        runTicks([
            [0.98, 0.99],
            [0.9, 0.95],
            [0.8, 0.9],
            [0.7, 0.85],
            [0.6, 0.8],
            [0.5, 0.75],
            [0.4, 0.7],
        ]);
        expect(liveText()).toMatch(/Clear \d+–\d+%\?/);

        // What maybeReplayFight stores when a replay of this fight completes
        labyrinthClearRate._replay = {
            clearChance: 0.63,
            trials: 400,
            halfWidth: 0.02,
            at: Date.now(),
            fightStartedAt: labyrinthClearRate._fight.startedAt,
        };
        runTicks([[0.38, 0.68]]);

        expect(liveText()).toContain('Clear 63%');
    });
});
