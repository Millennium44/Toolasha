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
    snapshots: [],
    owned: [],
    locations: [],
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
    get SKILLING_LOCATIONS() {
        return mocks.locations;
    },
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
vi.mock('../combat/loadout-snapshot.js', async () => {
    const { attachTalismanBonuses } = await import('../../utils/talisman-bonuses.js');
    return {
        default: {
            getAllSnapshots: () => mocks.snapshots,
            resolveEquipment: (snap) => snap.equipment,
            // The loadout's map with its own talisman share attached, as the real store builds it
            equipmentMapOf: (snap) =>
                attachTalismanBonuses(new Map(snap.equipment.map((e) => [e.itemLocationHrid, e])), {
                    noncombat: { skillingSpeed: snap.share },
                    buffs: {},
                    combat: {},
                }),
        },
    };
});
vi.mock('../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    marketDepthCap: () => null,
    guildMemberSkills: () => null,
    loadoutSnapshot: () => null,
    dataManager: () => ({ getCharacterTalismans: () => mocks.owned }),
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
const { talismanBonusesOf } = await import('../../utils/talisman-bonuses.js');

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

describe('Optimizer Talismans section: the gear it ranks on', () => {
    const BELT = '/item_locations/belt';
    const loadout = (extra = {}) => ({
        name: 'Woodcutting',
        isDefault: true,
        share: 0.07,
        talismanIdMap: { 1: 11, 2: 0, 3: 0 },
        equipment: [
            { itemLocationHrid: BELT, itemHrid: '/items/large_talisman_belt', enhancementLevel: 10 },
            { itemLocationHrid: '/item_locations/main_hand', itemHrid: '/items/axe_a', enhancementLevel: 2 },
        ],
        ...extra,
    });
    beforeEach(() => {
        mocks.snapshots = [loadout()];
        mocks.owned = [{ id: 11 }];
        mocks.locations = ['/item_locations/main_hand', '/item_locations/head'];
        ui.currentMode = 'simulator';
        ui.simLoadoutName = null;
        ui.equipment = new Map();
        ui.teas = [null, null, null];
    });

    test('no loadout picked: none (the skill loadout is used)', () => {
        expect(ui._talismanGearContext()).toBeNull();
    });

    test('Optimizer mode: none, even with a loadout remembered', () => {
        ui.simLoadoutName = 'Woodcutting';
        ui.currentMode = 'optimizer';
        expect(ui._talismanGearContext()).toBeNull();
    });

    test('a picked loadout: its belt and talisman share, the rows as edited over its other slots', () => {
        ui.simLoadoutName = 'Woodcutting';
        ui.equipment = new Map([['/item_locations/head', { itemHrid: '/items/hat_b', enhancementLevel: 3 }]]);
        ui.teas = ['/items/tea_x', null, null];
        const ctx = ui._talismanGearContext();
        expect(ctx.label).toBe('Woodcutting ★ loadout');
        expect(ctx.equipment.get(BELT)).toMatchObject({ itemHrid: '/items/large_talisman_belt', enhancementLevel: 10 });
        // The loadout's weapon was cleared in the rows: gone; the head row is the edited one
        expect(ctx.equipment.has('/item_locations/main_hand')).toBe(false);
        expect(ctx.equipment.get('/item_locations/head')).toMatchObject({
            itemLocationHrid: '/item_locations/head',
            itemHrid: '/items/hat_b',
            enhancementLevel: 3,
        });
        expect(talismanBonusesOf(ctx.equipment).noncombat.skillingSpeed).toBe(0.07);
        expect(ctx.drinks).toEqual([{ itemHrid: '/items/tea_x' }]);
        expect(ctx.note).toBe('');
    });

    test('a fresh Map each call, and the key moves with a row, a tea or the loadout', () => {
        ui.simLoadoutName = 'Woodcutting';
        const a = ui._talismanGearContext();
        expect(ui._talismanGearContext().equipment).not.toBe(a.equipment);
        ui.equipment.set('/item_locations/head', { itemHrid: '/items/hat_b', enhancementLevel: 0 });
        const b = ui._talismanGearContext();
        expect(b.key).not.toBe(a.key);
        ui.teas = ['/items/tea_x', null, null];
        expect(ui._talismanGearContext().key).not.toBe(b.key);
        mocks.snapshots = [loadout({ equipment: [] })];
        expect(ui._talismanGearContext().key).not.toBe(a.key);
    });

    test('a loadout without a belt has none in its map', () => {
        mocks.snapshots = [loadout({ equipment: [] })];
        ui.simLoadoutName = 'Woodcutting';
        expect(ui._talismanGearContext().equipment.get(BELT)).toBeUndefined();
    });

    test('talismans the character no longer owns are counted in the note', () => {
        mocks.snapshots = [loadout({ talismanIdMap: { 1: 11, 2: 12, 3: 0 } })];
        ui.simLoadoutName = 'Woodcutting';
        expect(ui._talismanGearContext().note).toContain('1 of this loadout');
    });

    test('a loadout deleted since: none', () => {
        ui.simLoadoutName = 'Woodcutting';
        mocks.snapshots = [];
        expect(ui._talismanGearContext()).toBeNull();
    });

    test('picking and clearing the loadout tells the section; a character switch forgets the pick', () => {
        const gearChanged = vi.fn();
        ui._talismanSection = { gearChanged, detach() {} };
        ui._loadLoadout('Woodcutting');
        expect(ui.simLoadoutName).toBe('Woodcutting');
        ui._loadLoadout('');
        expect(ui.simLoadoutName).toBeNull();
        expect(gearChanged).toHaveBeenCalledTimes(2);
        ui._loadLoadout('Woodcutting');
        ui.cleanup();
        expect(ui.simLoadoutName).toBeNull();
    });
});
