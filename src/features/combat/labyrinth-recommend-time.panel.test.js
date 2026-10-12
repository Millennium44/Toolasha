/** @vitest-environment happy-dom */

/**
 * Recommend by Time through the Labyrinth Clear Rate panel: the searches, the
 * records a run writes, their readers, the persisted target and the controls.
 * The search rules themselves are in labyrinth-recommend-time.test.js.
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

describe('Recommend by Time', () => {
    const impCell = () => {
        const cell = document.createElement('div');
        cell.className = 'LabyrinthPanel_skipThreshold_abc';
        cell.setAttribute('data-hrid', '/monsters/imp');
        document.body.appendChild(cell);
        vi.spyOn(panel, 'extractRoomHrid').mockImplementation((el) => el.getAttribute('data-hrid'));
    };

    beforeEach(() => {
        settings.map.clear();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        panel.recommendations.clear();
        panel._recommendBasis = 'winRate';
        panel.recommendRunning = false;
        document.body.innerHTML = '';
        settings.map.clear();
        vi.restoreAllMocks();
    });

    test('the combat search takes the highest level within the target from measured sims', async () => {
        vi.spyOn(panel, 'getPlayerEffectiveCombatLevel').mockReturnValue(100);
        const options = [];
        vi.spyOn(panel, 'computeCombatClear').mockImplementation(async (hrid, roomLevel, opts) => {
            options.push(opts);
            return { clearChance: 0.9, expectedSeconds: 100 + (roomLevel - 100) * 10 };
        });

        const found = await panel.findRecommendedThresholdSecondsCombat('/monsters/imp', 300);

        // 100 + 10(room - 100) <= 300 -> room 120 -> threshold = room - eff + 1 = 21
        expect(found).toEqual({ threshold: 21, seconds: 300, qualifies: true });
        // Never a decision sim: it stops too early to carry a time figure
        expect(options.every((o) => o.decideAgainst === undefined)).toBe(true);
    });

    test('a combat probe cancelled from outside discards the search', async () => {
        vi.spyOn(panel, 'getPlayerEffectiveCombatLevel').mockReturnValue(100);
        let probes = 0;
        vi.spyOn(panel, 'computeCombatClear').mockImplementation(async () =>
            ++probes === 2
                ? { clearChance: 0, expectedSeconds: Infinity, failed: true, cancelled: true }
                : { clearChance: 1, expectedSeconds: 10 }
        );
        panel.beginSimBatch();
        expect(await panel.findRecommendedThresholdSecondsCombat('/monsters/imp', 300)).toBeNull();
    });

    test('a non-monotone combat curve still lands on the higher pass', async () => {
        vi.spyOn(panel, 'getPlayerEffectiveCombatLevel').mockReturnValue(100);
        vi.spyOn(panel, 'computeCombatClear').mockImplementation(async (hrid, roomLevel) => ({
            clearChance: 0.5,
            expectedSeconds: roomLevel <= 109 || roomLevel === 113 ? 200 : 900,
        }));
        const found = await panel.findRecommendedThresholdSecondsCombat('/monsters/imp', 300);
        // room 113 -> threshold 14
        expect(found.threshold).toBe(14);
    });

    test('the skilling search reads the same expectedSeconds the clear-rate panel shows', async () => {
        vi.spyOn(panel, 'getEffectiveLevel').mockReturnValue(100);
        vi.spyOn(panel, 'computeSkillingClear').mockImplementation((hrid, roomLevel) => ({
            clearChance: 0.8,
            expectedSeconds: 50 + (roomLevel - 100) * 5,
        }));
        const found = await panel.findRecommendedThresholdSeconds('/skills/milking', 100);
        // 50 + 5d <= 100 -> d = 10 -> room 110 -> threshold 11
        expect(found).toEqual({ threshold: 11, seconds: 100, qualifies: true });
    });

    test('a run stores basis, target and the closest miss on each record', async () => {
        impCell();
        vi.spyOn(panel, 'findRecommendedThresholdSecondsCombat').mockResolvedValue({
            threshold: -3,
            seconds: 640,
            qualifies: false,
        });
        const winRate = vi.spyOn(panel, 'findRecommendedThresholdCombat');
        document.body.insertAdjacentHTML('beforeend', '<input id="mwi-recommend-target-seconds" value="450">');

        await panel.runRecommendations('seconds');

        expect(winRate).not.toHaveBeenCalled();
        expect(panel.recommendations.get('/monsters/imp')).toMatchObject({
            threshold: -3,
            basis: 'seconds',
            target: 450,
            qualifies: false,
            seconds: 640,
            basisKey: 'seconds=450',
        });
        expect(settings.map.get('labyrinthRecommendTargetSeconds')).toBe(450);
    });

    test('the win-rate run stamps its own basis, distinct from a time run at the same number', async () => {
        impCell();
        vi.spyOn(panel, 'findRecommendedThresholdCombat').mockResolvedValue(5);
        settings.map.set('labyrinthRecommendTargetRate', 70);
        await panel.runRecommendations();
        expect(panel.recommendations.get('/monsters/imp')).toMatchObject({
            threshold: 5,
            basis: 'winRate',
            target: 70,
            basisKey: 'winRate=70',
        });
    });

    test('a closest miss is shown on the badge but not applied by the readers', () => {
        impCell();
        vi.spyOn(panel, 'getCombatSkipThreshold').mockReturnValue(10);
        vi.spyOn(panel, 'getPlayerEffectiveCombatLevel').mockReturnValue(100);
        panel.recommendations.set('/monsters/imp', {
            threshold: -3,
            basis: 'seconds',
            target: 300,
            qualifies: false,
            seconds: 640,
        });

        panel.injectRecommendationBadges();

        const badge = document.querySelector('.mwi-labyrinth-recommend');
        expect(badge.title).toContain('No level meets the 300s expected clear time');
        expect(badge.title).toContain('640s');
        expect(panel.getRecommendedCombatRoomLevel('/monsters/imp')).toBe(0);

        panel.recommendations.set('/monsters/imp', {
            threshold: 4,
            basis: 'seconds',
            target: 300,
            qualifies: true,
            seconds: 290,
        });
        expect(panel.getRecommendedCombatRoomLevel('/monsters/imp')).toBe(103);
    });

    test('the target time is persisted, clamped to 1..100000, and defaults to 300', () => {
        expect(panel.getRecommendTargetSeconds()).toBe(300);
        document.body.innerHTML = '<input id="mwi-recommend-target-seconds" value="9999999">';
        expect(panel.getRecommendTargetSeconds()).toBe(100000);
        expect(document.getElementById('mwi-recommend-target-seconds').value).toBe('100000');
        expect(settings.map.get('labyrinthRecommendTargetSeconds')).toBe(100000);
        // An unusable entry falls back to the stored setting
        document.body.innerHTML = '<input id="mwi-recommend-target-seconds" value="-4">';
        settings.map.set('labyrinthRecommendTargetSeconds', 60);
        expect(panel.getRecommendTargetSeconds()).toBe(60);
    });

    test('the controls carry a Target time input and a Recommend by Time button, seeded from the setting', () => {
        document.body.innerHTML = '<div><table class="LabyrinthPanel_automationTable_x"></table></div>';
        settings.map.set('labyrinthRecommendTargetSeconds', 420);

        panel.injectRecommendControls();

        expect(document.getElementById('mwi-recommend-target-seconds').value).toBe('420');
        const button = document.querySelector('.mwi-labyrinth-recommend-controls-run-seconds');
        expect(button.textContent).toBe('Recommend by Time');

        const run = vi.spyOn(panel, 'runRecommendations').mockResolvedValue();
        button.click();
        expect(run).toHaveBeenCalledWith('seconds');
    });

    test('while a time run is going its button is the Cancel and the other is held', () => {
        document.body.innerHTML = '<div><table class="LabyrinthPanel_automationTable_x"></table></div>';
        panel.injectRecommendControls();
        panel._recommendBasis = 'seconds';
        panel.recommendRunning = true;
        panel.refreshAutomationRunningState(2, 5);
        const timeButton = document.querySelector('.mwi-labyrinth-recommend-controls-run-seconds');
        const winButton = document.querySelector('.mwi-labyrinth-recommend-controls-run');
        expect(timeButton.textContent).toBe('Cancel (2/5)');
        expect(winButton.disabled).toBe(true);
        panel.recommendRunning = false;
        panel.refreshAutomationRunningState();
        expect(timeButton.textContent).toBe('Recommend by Time');
        expect(winButton.disabled).toBe(false);
    });
});
