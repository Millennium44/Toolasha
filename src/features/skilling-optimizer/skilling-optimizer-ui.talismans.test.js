/** @vitest-environment happy-dom */
/**
 * The Optimizer tab's Talismans section: drawn on the test server while `skillingOptimizer_talismans` is on, kept
 * (with its result) across panel rebuilds, and let go on cleanup.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    talismansSetting: true,
    talismansAvailable: true,
    optimizeSkill: vi.fn(() => null),
    performance: { xpPerHour: 100, goldPerHour: 0, teaCostPerHour: 0, hasMissingPrices: false },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#22c55e',
        COLOR_INFO: '#0af',
        COLOR_PROFIT: '#0f0',
        getSetting: (key) => (key === 'skillingOptimizer_talismans' ? mocks.talismansSetting : true),
    },
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

vi.mock('../talismans/skilling-talisman-section.js', () => ({
    skillingTalismansAvailable: () => mocks.talismansAvailable,
    SkillingTalismanSection: class {
        constructor(host) {
            this.host = host;
            this.root = null;
            this.refreshed = 0;
        }
        mount(container) {
            this.root = document.createElement('div');
            this.root.className = 'talisman-section-test';
            container.appendChild(this.root);
        }
        refreshActions() {
            this.refreshed++;
        }
        detach() {
            this.root?.remove();
            this.root = null;
        }
    },
}));

const { skillingSimulatorUI: ui } = await import('./skilling-optimizer-ui.js');

beforeEach(() => {
    mocks.talismansSetting = true;
    mocks.talismansAvailable = true;
    ui._talismanSection?.detach();
    ui._talismanSection = null;
});

describe('Optimizer Talismans section', () => {
    test('drawn on the test server with the setting on, and follows the Optimizer skill', () => {
        const panel = document.createElement('div');
        ui._mountTalismans(panel);
        expect(panel.querySelector('.talisman-section-test')).not.toBeNull();
        ui.currentSkill = 'Milking';
        expect(ui._talismanSection.host.getSkill()).toBe('Milking');
    });

    test('kept across a rebuild, its action list refreshed', () => {
        const first = document.createElement('div');
        ui._mountTalismans(first);
        const section = ui._talismanSection;
        const second = document.createElement('div');
        ui._mountTalismans(second);
        expect(ui._talismanSection).toBe(section);
        expect(second.querySelector('.talisman-section-test')).not.toBeNull();
        expect(section.refreshed).toBe(1);
    });

    test('setting off: not drawn, and a drawn one is let go', () => {
        ui._mountTalismans(document.createElement('div'));
        mocks.talismansSetting = false;
        const panel = document.createElement('div');
        ui._mountTalismans(panel);
        expect(panel.querySelector('.talisman-section-test')).toBeNull();
        expect(ui._talismanSection).toBeNull();
    });

    test('live server: not drawn', () => {
        mocks.talismansAvailable = false;
        const panel = document.createElement('div');
        ui._mountTalismans(panel);
        expect(panel.querySelector('.talisman-section-test')).toBeNull();
    });

    test('cleanup lets the section go', () => {
        ui._mountTalismans(document.createElement('div'));
        ui.cleanup();
        expect(ui._talismanSection).toBeNull();
    });
});
