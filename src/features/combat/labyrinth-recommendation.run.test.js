/** @vitest-environment happy-dom */

/**
 * A full Recommend run over a table mixing skilling and combat rooms, with the
 * searches mocked: every row has to end the run carrying its Rec badge, even
 * when the inputs change under the run (a lab loadout swap mid-search).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ map: new Map() }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn(() => true),
        setSetting: vi.fn(),
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
        onReady: vi.fn((name, cb) => {
            cb();
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
        getCommunityBuffLevel: () => 0,
        getCharacterGuildBuffLevel: () => 0,
        getInventory: () => null,
        characterData: null,
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    buildPlayerDTO: vi.fn(),
    buildGameDataPayload: vi.fn(),
    applyLoadoutSnapshotToDTO: vi.fn(),
    getCommunityBuffs: () => ({ mooPass: false, comExp: 0, comDrop: 0 }),
    getGuildBuffDetailMap: () => ({}),
    applyGuildBuffLevel: (buffs) => buffs,
}));
vi.mock('../combat-sim/combat-sim-runner.js', () => ({
    runLabyrinthSimulation: vi.fn(),
    runBlindBuffProbe: vi.fn(),
    runPlayerStatProbe: vi.fn(),
    cancelSimulation: vi.fn(),
}));
vi.mock('../../api/marketplace.js', () => ({ default: { isLoaded: () => false, getPrice: () => null } }));
vi.mock('./loadout-snapshot.js', () => ({
    default: {
        snapshots: {},
        snapshotsReady: true,
        whenReady: () => Promise.resolve(true),
        onUpdate: () => {},
        offUpdate: () => {},
        resolveEquipment: (snapshot) => snapshot?.equipment || [],
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, store, fallback = null) => fallback,
        getJSON: async (key, store, fallback = null) => fallback,
        tryGet: async () => ({ found: false, value: null }),
        set: async () => true,
        setJSON: async () => true,
        delete: async () => true,
        getAllKeys: async () => [],
    },
}));

const { default: panel } = await import('./labyrinth-clear-rate.js');

const SKILLS = ['/skills/milking', '/skills/foraging', '/skills/cooking'];
const MONSTERS = ['/monsters/pyre_hunter', '/monsters/frost_sniper', '/monsters/siren'];
const ALL = [...SKILLS, ...MONSTERS];

describe('Recommend run over skilling and combat rooms', () => {
    let fingerprint;

    const buildTable = () => {
        for (const hrid of ALL) {
            const cell = document.createElement('div');
            cell.className = 'LabyrinthPanel_skipThreshold_abc';
            cell.setAttribute('data-hrid', hrid);
            document.body.appendChild(cell);
        }
        vi.spyOn(panel, 'extractRoomHrid').mockImplementation((el) => el.getAttribute('data-hrid'));
        vi.spyOn(panel, 'getSkipThreshold').mockReturnValue(5);
        vi.spyOn(panel, 'getCombatSkipThreshold').mockReturnValue(5);
        vi.spyOn(panel, 'getEffectiveLevel').mockReturnValue(100);
        vi.spyOn(panel, 'computeSkillingClear').mockReturnValue({ clearChance: 0.5, expectedSeconds: 60 });
        vi.spyOn(panel, 'computeEnhancingClear').mockReturnValue({ clearChance: 0.5, expectedSeconds: 60 });
    };

    const badgedRooms = () =>
        [...document.querySelectorAll('.mwi-labyrinth-recommend')].map((badge) =>
            badge.closest('[data-hrid]').getAttribute('data-hrid')
        );

    /** The lab equips the next room's loadout: equipment_buffs_updated → invalidation */
    const inputsChange = (next) => {
        fingerprint = next;
        panel._invalidateIfInputsChanged();
    };

    beforeEach(() => {
        settings.map.clear();
        document.body.innerHTML = '';
        fingerprint = 'gear-a';
        vi.spyOn(panel, '_snapshotContentFingerprint').mockImplementation(() => fingerprint);
        vi.spyOn(panel, '_recommendSettingsFingerprint').mockReturnValue('settings');
        vi.spyOn(panel, '_clearPersistedCombatCache').mockImplementation(() => {});
    });

    afterEach(() => {
        panel.recommendations.clear();
        panel.recommendRunning = false;
        panel._settingsFingerprint = null;
        panel._snapshotFingerprint = null;
        document.body.innerHTML = '';
        settings.map.clear();
        vi.restoreAllMocks();
    });

    test('an input change mid-run leaves every row, skilling and combat, with its badge', async () => {
        buildTable();
        vi.spyOn(panel, 'findRecommendedThreshold').mockReturnValue(8);
        let searched = 0;
        vi.spyOn(panel, 'findRecommendedThresholdCombat').mockImplementation(async () => {
            // While the second combat room is being searched the inputs move,
            // and the table redraws its badges from whatever the map holds
            if (++searched === 2) {
                inputsChange('gear-b');
                panel.injectRecommendationBadges();
            }
            return 6;
        });

        await panel.runRecommendations();

        expect(badgedRooms().sort()).toEqual([...ALL].sort());
        for (const hrid of ALL) {
            expect(Number.isFinite(panel.recommendations.get(hrid)?.threshold)).toBe(true);
        }
    });

    test('a time run keeps every row through the same mid-run change', async () => {
        buildTable();
        vi.spyOn(panel, 'findRecommendedThresholdSeconds').mockResolvedValue({
            threshold: 8,
            seconds: 90,
            qualifies: true,
        });
        let searched = 0;
        vi.spyOn(panel, 'findRecommendedThresholdSecondsCombat').mockImplementation(async () => {
            if (++searched === 2) inputsChange('gear-b');
            return { threshold: 6, seconds: 200, qualifies: true };
        });

        await panel.runRecommendations('seconds');

        expect(badgedRooms().sort()).toEqual([...ALL].sort());
    });

    test('skilling rooms are searched again against the inputs that changed under the run', async () => {
        buildTable();
        let level = 8;
        vi.spyOn(panel, 'findRecommendedThreshold').mockImplementation(() => level);
        vi.spyOn(panel, 'findRecommendedThresholdCombat').mockImplementation(async (hrid) => {
            if (hrid === MONSTERS[1]) {
                level = 12;
                inputsChange('gear-b');
            }
            return 6;
        });

        await panel.runRecommendations();

        for (const hrid of SKILLS) expect(panel.recommendations.get(hrid).threshold).toBe(12);
        expect(panel._recommendInputsChangedMidRun).toBe(false);
    });

    test('combat rooms searched before a mid-run change are searched again, so no run mixes two sets of gear', async () => {
        buildTable();
        vi.spyOn(panel, 'findRecommendedThreshold').mockReturnValue(8);
        let gearLevel = 6;
        const calls = [];
        vi.spyOn(panel, 'findRecommendedThresholdCombat').mockImplementation(async (hrid) => {
            calls.push(hrid);
            const answer = gearLevel;
            // The gear changes while the second combat room is being searched
            if (calls.length === 2) {
                gearLevel = 9;
                inputsChange('gear-b');
            }
            return answer;
        });

        await panel.runRecommendations();

        for (const hrid of MONSTERS) expect(panel.recommendations.get(hrid).threshold).toBe(9);
        // The room searched wholly after the change is not searched twice
        expect(calls.filter((hrid) => hrid === MONSTERS[2])).toHaveLength(1);
    });

    test('a change between runs still drops the recommendations it made stale', async () => {
        buildTable();
        vi.spyOn(panel, 'findRecommendedThreshold').mockReturnValue(8);
        vi.spyOn(panel, 'findRecommendedThresholdCombat').mockResolvedValue(6);
        await panel.runRecommendations();
        expect(panel.recommendations.size).toBe(ALL.length);

        fingerprint = 'gear-b';
        expect(panel._invalidateIfInputsChanged()).toBe(true);
        expect(panel.recommendations.size).toBe(0);
    });

    test('a combat probe that could not run abandons the win-rate search instead of scoring a miss', async () => {
        vi.spyOn(panel, 'getPlayerEffectiveCombatLevel').mockReturnValue(100);
        vi.spyOn(panel, 'automationSimOptions').mockReturnValue({});
        let probes = 0;
        // The first probe (threshold 0) fails to run; every room actually clears.
        // Scored as a 0% clear it pushed the search down to -1.
        vi.spyOn(panel, 'computeCombatClear').mockImplementation(async () =>
            ++probes === 1
                ? { clearChance: 0, expectedSeconds: Infinity, failed: true }
                : { clearChance: 1, expectedSeconds: 10 }
        );
        panel.beginSimBatch();
        expect(await panel.findRecommendedThresholdCombat('/monsters/imp', 0.3)).toBeNull();
    });
});
