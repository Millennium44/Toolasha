/** @vitest-environment happy-dom */
/**
 * Teardown of the skilling panel: a scoring pass queued behind the next frame must not run for a
 * character that has since been switched away from, cleanup() must clear the Simulator's own
 * inputs, and the Simulator says why an XP figure is low when drinks block actions.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    optimizeSkill: vi.fn(() => null),
    performance: { xpPerHour: 100, goldPerHour: 0, teaCostPerHour: 0, hasMissingPrices: false },
}));

vi.mock('../../core/config.js', () => ({
    default: { COLOR_ACCENT: '#22c55e', COLOR_INFO: '#0af', COLOR_PROFIT: '#0f0', getSetting: () => true },
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: () => () => {},
}));
vi.mock('./skilling-optimizer-engine.js', () => ({
    calculateSkillPerformance: () => mocks.performance,
    getSkillActionsForDisplay: () => [],
    getItemsForSlot: () => [],
    getAlchemyItemOptions: () => [],
    buildAchievableEquipment: () => new Map(),
    getSkillDrinkItems: () => [],
    getPlayerSkillLevel: () => 50,
    optimizeSkill: mocks.optimizeSkill,
    findOptimalTeas: () => null,
    calculateSlotUpgradeCost: () => null,
    SKILL_NAMES: ['Woodcutting'],
    SKILLING_LOCATIONS: [],
    SLOT_DISPLAY_NAMES: {},
    SKILL_TOOL_LOCATION: {},
}));
vi.mock('../../utils/tea-optimizer.js', () => ({
    findXpFloorChoice: () => ({ status: 'none' }),
    pickXpFloorChoice: () => ({ status: 'none' }),
    normalizeXpFloorPercent: (value) => value,
    scoreEquipmentSetup: () => null,
}));
vi.mock('../../utils/house-roi.js', () => ({
    rankHouseRoomUpgrades: () => ({ rows: [], excluded: [], skills: [], offBoardRooms: 0 }),
    compareHouseRoiRows: () => 0,
}));
vi.mock('../../utils/loadout-scraper.js', () => ({
    buildEnhancementLevelMap: () => new Map(),
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getAllSnapshots: () => [] },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    marketDepthCap: () => null,
    guildMemberSkills: () => null,
    loadoutSnapshot: () => null,
    dataManager: null,
}));

const { skillingSimulatorUI: ui, default: skillingOptimizer } = await import('./skilling-optimizer-ui.js');

function openPanel(mode) {
    ui.currentMode = mode;
    skillingOptimizer.initialize();
    ui.panel = ui._buildPanel();
    document.body.appendChild(ui.panel);
    return ui.panel;
}

const clickButton = (panel, label) =>
    [...panel.querySelectorAll('button')].find((b) => b.textContent === label).click();

beforeEach(() => {
    vi.useFakeTimers();
    mocks.optimizeSkill.mockClear();
    mocks.performance = { xpPerHour: 100, goldPerHour: 0, teaCostPerHour: 0, hasMissingPrices: false };
});

afterEach(() => {
    skillingOptimizer.cleanup();
    ui.currentMode = 'simulator';
    document.body.replaceChildren();
    vi.useRealTimers();
});

describe('a scoring pass queued behind the next frame', () => {
    test('Optimize does not run, or keep a result, once the panel was torn down', () => {
        const panel = openPanel('optimizer');
        mocks.optimizeSkill.mockReturnValue({ slots: {}, playerLevel: 50, skill: 'Woodcutting' });
        clickButton(panel, 'Optimize');

        skillingOptimizer.cleanup();
        vi.advanceTimersByTime(100);

        expect(mocks.optimizeSkill).not.toHaveBeenCalled();
        expect(ui.lastOptimizerResult).toBeNull();
    });

    test('Optimize still runs while its panel is open', () => {
        const panel = openPanel('optimizer');
        clickButton(panel, 'Optimize');
        vi.advanceTimersByTime(100);
        expect(mocks.optimizeSkill).toHaveBeenCalledTimes(1);
    });
});

describe('cleanup() clears the Simulator inputs', () => {
    test('gear, drinks and the action selection do not carry to the next character', () => {
        skillingOptimizer.initialize();
        ui.equipment.set('/item_locations/main_hand', { itemHrid: '/items/axe', enhancementLevel: 5 });
        ui.teas = ['/items/efficiency_tea', null, null];
        ui.selectedActionHrids = new Set(['/actions/woodcutting/tree']);

        skillingOptimizer.cleanup();

        expect(ui.equipment.size).toBe(0);
        expect(ui.teas).toEqual([null, null, null]);
        expect(ui.selectedActionHrids).toBeNull();
    });
});

describe('Simulator result for drinks that block actions', () => {
    test('names how many actions cannot start', () => {
        mocks.performance = { ...mocks.performance, blockedActionCount: 2, actionsOffered: 5 };
        const panel = openPanel('simulator');
        clickButton(panel, 'Simulate');
        vi.advanceTimersByTime(100);
        expect(panel.textContent).toContain('2 of 5 actions cannot start');
    });

    test('says nothing when every action can start', () => {
        mocks.performance = { ...mocks.performance, blockedActionCount: 0, actionsOffered: 5 };
        const panel = openPanel('simulator');
        clickButton(panel, 'Simulate');
        vi.advanceTimersByTime(100);
        expect(panel.textContent).not.toContain('cannot start');
    });
});
