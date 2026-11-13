/** @vitest-environment happy-dom */

/**
 * openForSkill: the Optimizer shows a skill with one action preselected, opening the character
 * panel first when it is closed, and switching to the tab when another tab is showing.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    ensureOpen: vi.fn(() => true),
    toast: vi.fn(),
    actions: [
        { hrid: '/actions/woodcutting/tree', available: true },
        { hrid: '/actions/woodcutting/birch_tree', available: true },
        { hrid: '/actions/woodcutting/locked', available: false },
    ],
}));

vi.mock('../../core/config.js', () => ({
    default: { COLOR_ACCENT: '#22c55e', COLOR_INFO: '#0af', COLOR_PROFIT: '#0f0', getSetting: () => true },
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../utils/character-panel.js', () => ({ ensureCharacterPanelOpen: mocks.ensureOpen }));
vi.mock('../../utils/toast.js', () => ({ showToast: mocks.toast }));
vi.mock('./skilling-optimizer-engine.js', () => ({
    calculateSkillPerformance: () => ({}),
    getSkillActionsForDisplay: () => mocks.actions,
    getItemsForSlot: () => [],
    getAlchemyItemOptions: () => [],
    buildAchievableEquipment: () => new Map(),
    getSkillDrinkItems: () => [],
    getPlayerSkillLevel: () => 50,
    optimizeSkill: () => null,
    findOptimalTeas: () => null,
    calculateSlotUpgradeCost: () => null,
    SKILL_NAMES: ['Milking', 'Foraging', 'Woodcutting'],
    SKILLING_LOCATIONS: [],
    SLOT_DISPLAY_NAMES: {},
    SKILL_TOOL_LOCATION: {},
}));

const { skillingSimulatorUI: ui } = await import('./skilling-optimizer-ui.js');

function mountTabs() {
    document.body.innerHTML = `<div class="TabsComponent_tabsContainer__x"><div class="MuiTabs-scroller"><div role="tablist">
        <button role="tab" class="Mui-selected">Inventory</button>
        <button role="tab">Loadouts</button></div></div></div><div class="TabsComponent_tabPanelsContainer__y"></div>`;
}

describe('openForSkill', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        ui.cleanup();
        ui.initialize();
        mocks.ensureOpen.mockClear();
        mocks.toast.mockClear();
    });

    test('panel open on another tab: switches to Optimizer, skill and the given action', async () => {
        mountTabs();
        ui._tryInjectTabButton();
        expect(await ui.openForSkill('/skills/woodcutting', '/actions/woodcutting/birch_tree')).toBe(true);
        expect(ui.isActive).toBe(true);
        expect(ui.currentSkill).toBe('Woodcutting');
        expect([...ui.selectedActionHrids]).toEqual(['/actions/woodcutting/birch_tree']);
        expect(document.querySelector('.toolasha-skilling-opt-tab').classList.contains('Mui-selected')).toBe(true);
    });

    test('no running action: preselects the first available action', async () => {
        mountTabs();
        ui._tryInjectTabButton();
        await ui.openForSkill('/skills/woodcutting', null);
        expect([...ui.selectedActionHrids]).toEqual(['/actions/woodcutting/tree']);
    });

    test('panel closed: opens it, waits for the tab strip, then selects the tab', async () => {
        mocks.ensureOpen.mockImplementationOnce(() => {
            setTimeout(() => mountTabs(), 0);
            return true;
        });
        expect(ui.tabBtn).toBeNull();
        expect(await ui.openForSkill('/skills/woodcutting', null)).toBe(true);
        expect(mocks.ensureOpen).toHaveBeenCalledTimes(1);
        expect(ui.isActive).toBe(true);
        expect(ui.panel).not.toBeNull();
    });

    test('panel cannot be opened: toasts and changes nothing', async () => {
        mocks.ensureOpen.mockReturnValueOnce(false);
        expect(await ui.openForSkill('/skills/woodcutting', null)).toBe(false);
        expect(mocks.toast).toHaveBeenCalledTimes(1);
        expect(ui.isActive).toBe(false);
    });

    test('a skill the Optimizer does not have: refuses without touching the panel', async () => {
        expect(await ui.openForSkill('/skills/enhancing', null)).toBe(false);
        expect(mocks.ensureOpen).not.toHaveBeenCalled();
    });

    test('cleanup unregisters the opener so skill pages stop offering it', async () => {
        const { canOpenInOptimizer } = await import('../../utils/optimizer-bridge.js');
        expect(canOpenInOptimizer('/skills/woodcutting')).toBe(true);
        ui.cleanup();
        expect(canOpenInOptimizer('/skills/woodcutting')).toBe(false);
    });
});
