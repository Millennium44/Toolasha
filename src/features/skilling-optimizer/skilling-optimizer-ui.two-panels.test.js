/** @vitest-environment happy-dom */

/**
 * openForSkill against both copies of the character panel the game draws, with the real character-panel
 * helpers. Phone (seen live): the side copy never shows; pressing My Stuff mounts a second copy inside the
 * main panel, and that is the one to select the Optimizer in. Desktop: the side copy is on screen.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    characterId: 'char-1',
    press: vi.fn(() => 'react'),
    toast: vi.fn(),
    actions: [{ hrid: '/actions/foraging/x', available: true }],
}));

vi.mock('../../core/config.js', () => ({
    default: { COLOR_ACCENT: '#22c55e', COLOR_INFO: '#0af', COLOR_PROFIT: '#0f0', getSetting: () => true },
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../utils/react-click.js', () => ({ clickThroughReact: (el, o) => mocks.press(el, o) }));
vi.mock('../../utils/bundle-bridge.js', async (importOriginal) => ({
    ...(await importOriginal()),
    dataManager: () => ({ getCurrentCharacterId: () => mocks.characterId }),
    guildMemberSkills: () => null,
    marketUndercutAlerts: () => null,
}));
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

const STRIP = `<div class="TabsComponent_tabsContainer__x"><div class="MuiTabs-scroller"><div role="tablist">
    <button role="tab" class="Mui-selected">Inventory</button><button role="tab">Loadouts</button></div></div></div>
    <div class="TabsComponent_tabPanelsContainer__y"></div>`;
const NAV = `<div class="NavigationBar_navigationLinks__1XSSb"><div class="NavigationBar_navigationLink__3eAHA NavigationBar_characterManagement__27qu3" id="mystuff"><svg><use href="/static/media/misc_sprite.d3f05174.svg#loot"></use></svg></div>
    <div class="NavigationBar_navigationLink__3eAHA"><svg><use href="/static/media/misc_sprite.d3f05174.svg#marketplace"></use></svg></div></div>`;
const side = (hidden) =>
    `<div class="GamePage_characterManagementPanel__z" id="side" ${hidden ? 'data-hidden="1"' : ''}>${STRIP}</div>`;
const mountMain = () => {
    const main = document.createElement('div');
    main.id = 'main';
    main.className = 'MainPanel_subPanelContainer__m';
    main.innerHTML = STRIP;
    document.body.appendChild(main);
};

describe('openForSkill with two copies of the character panel', () => {
    beforeEach(() => {
        Element.prototype.getClientRects = function () {
            return this.closest('[data-hidden]') ? [] : [{}];
        };
        document.body.innerHTML = '';
        ui.cleanup();
        mocks.press.mockReset();
        mocks.press.mockReturnValue('react');
        mocks.toast.mockClear();
        mocks.characterId = 'char-1';
    });

    test('phone: side copy hidden, no main copy: presses My Stuff and selects the tab in the main copy', async () => {
        document.body.innerHTML = NAV + side(true);
        ui.initialize();
        expect(document.querySelectorAll('.toolasha-skilling-opt-tab')).toHaveLength(1);
        mocks.press.mockImplementation((el) => {
            expect(el.id).toBe('mystuff');
            setTimeout(mountMain, 200);
            return 'react';
        });
        vi.useFakeTimers();
        try {
            const pending = ui.openForSkill('/skills/foraging', null);
            await vi.advanceTimersByTimeAsync(1500);
            expect(await pending).toBe(true);
        } finally {
            vi.useRealTimers();
        }
        expect(mocks.press).toHaveBeenCalledTimes(1);
        const mainTab = document.querySelector('#main .toolasha-skilling-opt-tab');
        expect(mainTab).not.toBeNull();
        expect(ui.tabBtn).toBe(mainTab);
        expect(mainTab.classList.contains('Mui-selected')).toBe(true);
        expect(document.querySelector('#main .toolasha-skilling-opt-panel')).not.toBeNull();
        expect(document.querySelector('#side .toolasha-skilling-opt-panel')).toBeNull();
        expect(mocks.toast).not.toHaveBeenCalled();
    });

    test('desktop: side copy on screen, nav link present: nothing pressed, side tab activated', async () => {
        document.body.innerHTML = NAV + side(false);
        ui.initialize();
        expect(await ui.openForSkill('/skills/foraging', null)).toBe(true);
        expect(mocks.press).not.toHaveBeenCalled();
        expect(ui.tabBtn).toBe(document.querySelector('#side .toolasha-skilling-opt-tab'));
        expect(document.querySelector('#side .toolasha-skilling-opt-panel')).not.toBeNull();
    });

    test('the main copy mounted while the side one is hidden gets its own tab, and a click on it builds there', async () => {
        document.body.innerHTML = NAV + side(true);
        ui.initialize();
        mountMain();
        ui._tryInjectTabButton();
        const mainTab = document.querySelector('#main .toolasha-skilling-opt-tab');
        expect(mainTab).not.toBeNull();
        mainTab.click();
        expect(ui.tabBtn).toBe(mainTab);
        expect(document.querySelector('#main .toolasha-skilling-opt-panel')).not.toBeNull();
    });

    test('My Stuff pressed but no copy ever shows: warns, returns false, selects nothing', async () => {
        document.body.innerHTML = NAV + side(true);
        ui.initialize();
        vi.useFakeTimers();
        try {
            const pending = ui.openForSkill('/skills/foraging', null);
            await vi.advanceTimersByTimeAsync(4000);
            expect(await pending).toBe(false);
        } finally {
            vi.useRealTimers();
        }
        expect(mocks.press).toHaveBeenCalledTimes(1);
        expect(mocks.toast).toHaveBeenCalledTimes(1);
        expect(ui.isActive).toBe(false);
        expect(document.querySelector('.toolasha-skilling-opt-panel')).toBeNull();
    });

    test('cleanup removes the tab, panel and hide class from both copies', () => {
        document.body.innerHTML = NAV + side(true);
        ui.initialize();
        mountMain();
        ui._tryInjectTabButton();
        document.querySelector('#main .toolasha-skilling-opt-tab').click();
        expect(document.querySelectorAll('.toolasha-skilling-opt-tab')).toHaveLength(2);

        ui.cleanup();

        expect(document.querySelectorAll('.toolasha-skilling-opt-tab')).toHaveLength(0);
        expect(document.querySelectorAll('.toolasha-skilling-opt-panel')).toHaveLength(0);
        expect(document.querySelectorAll('.toolasha-opt-hide-content')).toHaveLength(0);
    });

    test('desktop: opening My Stuff mounts a second copy that does not pull an open Optimizer out of the side', async () => {
        document.body.innerHTML = NAV + side(false);
        ui.initialize();
        await ui.openForSkill('/skills/foraging', null);
        const sideTab = document.querySelector('#side .toolasha-skilling-opt-tab');
        expect(ui.tabBtn).toBe(sideTab);

        mountMain();
        ui._tryInjectTabButton();

        const mainTab = document.querySelector('#main .toolasha-skilling-opt-tab');
        expect(mainTab).not.toBeNull();
        expect(ui.tabBtn).toBe(sideTab);
        expect(mainTab.classList.contains('Mui-selected')).toBe(false);
        expect(mainTab.getAttribute('aria-selected')).not.toBe('true');
        expect(document.querySelector('#main .toolasha-skilling-opt-panel')).toBeNull();
        expect(document.querySelector('#side .toolasha-skilling-opt-panel')).not.toBeNull();
    });

    test('phone: leaving My Stuff ends the open state, so mounting it again shows the game default tab', async () => {
        document.body.innerHTML = NAV + side(true);
        ui.initialize();
        mocks.press.mockImplementation(() => {
            mountMain();
            return 'react';
        });
        expect(await ui.openForSkill('/skills/foraging', null)).toBe(true);
        expect(ui.isActive).toBe(true);

        document.getElementById('main').remove();
        ui._syncTabs();
        expect(ui.isActive).toBe(false);
        expect(ui.tabBtn).toBeNull();

        mountMain();
        ui._syncTabs();
        const mainTab = document.querySelector('#main .toolasha-skilling-opt-tab');
        expect(mainTab).not.toBeNull();
        expect(ui.isActive).toBe(false);
        expect(mainTab.classList.contains('Mui-selected')).toBe(false);
        expect(document.querySelector('#main .toolasha-skilling-opt-panel')).toBeNull();
        expect(document.querySelector('#main .toolasha-opt-hide-content')).toBeNull();
    });

    test('a strip replaced in one change keeps the Optimizer open in the new one', async () => {
        document.body.innerHTML = NAV + side(false);
        ui.initialize();
        await ui.openForSkill('/skills/foraging', null);
        document.getElementById('side').remove();
        document.body.insertAdjacentHTML('beforeend', side(false));
        ui._syncTabs();
        expect(ui.isActive).toBe(true);
        expect(document.querySelector('#side .toolasha-skilling-opt-panel')).not.toBeNull();
    });

    test('selecting the Optimizer in the other copy un-highlights the first copy', async () => {
        document.body.innerHTML = NAV + side(false);
        ui.initialize();
        await ui.openForSkill('/skills/foraging', null);
        const sideTab = document.querySelector('#side .toolasha-skilling-opt-tab');
        mountMain();
        ui._tryInjectTabButton();

        document.querySelector('#main .toolasha-skilling-opt-tab').click();

        expect(sideTab.classList.contains('Mui-selected')).toBe(false);
        expect(sideTab.getAttribute('aria-selected')).toBe('false');
    });
});
