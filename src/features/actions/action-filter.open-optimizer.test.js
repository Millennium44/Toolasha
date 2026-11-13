/** @vitest-environment happy-dom */

/**
 * The "Open in Optimizer" control on a skill page's toolbar: present only while the Optimizer is
 * registered, enabled and has a view for the page's skill; its click hands the skill hrid (and the
 * running action of that skill, if any) to the Optimizer; re-rendering never duplicates it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: {},
    actions: [],
    skillIcon: null,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#abc',
        getSetting: (key) => mocks.settings[key],
        getSettingValue: (key, fallback) => mocks.settings[key] ?? fallback,
        setSetting: vi.fn(),
        getPricingModeLabel: (mode) => mode,
        getPricingModeDisplayLabel: (mode) => mode,
        onSettingChange: vi.fn(() => () => {}),
        onSettingsLoaded: vi.fn(() => () => {}),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: vi.fn(() => () => {}) } }));
vi.mock('../../core/storage.js', () => ({
    default: { get: async (_k, _s, fallback) => fallback, set: async () => true },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentActions: () => mocks.actions },
}));
vi.mock('../../utils/mobile.js', () => ({ isMobileMode: () => false, hasCoarsePointer: () => false }));
vi.mock('../../utils/game-lookups.js', () => ({
    getIconHref: () => mocks.skillIcon,
    getSkillHridFromIconHref: (href) => (href ? `/skills/${href}` : null),
}));
vi.mock('../../api/marketplace.js', () => ({ default: { fetch: vi.fn(async () => true) } }));
vi.mock('../../utils/market-values.js', () => ({
    nextPriceUp: (p) => p + 1,
    nextPriceDown: (p) => p - 1,
    clampToBand: (p) => p,
}));
vi.mock('./action-panel-sort.js', () => ({
    default: {
        onSortModeChange: vi.fn(() => () => {}),
        getSortMode: () => 'default',
        setSortMode: vi.fn(),
        sortPanelsByProfit: vi.fn(),
    },
}));
vi.mock('./profit-display.js', () => ({
    displayGatheringProfit: vi.fn(async () => {}),
    displayProductionProfit: vi.fn(async () => {}),
}));

const { default: actionFilter } = await import('./action-filter.js');
const { registerOptimizerOpener } = await import('../../utils/optimizer-bridge.js');

function makeTitle(skillLabel = 'Woodcutting') {
    const title = document.createElement('h1');
    title.className = 'GatheringProductionSkillPanel_title__3VihQ';
    const nameDiv = document.createElement('div');
    nameDiv.textContent = skillLabel;
    title.appendChild(nameDiv);
    document.body.appendChild(title);
    return title;
}

const buttons = () => document.querySelectorAll('#mwi-action-open-optimizer');

describe('Open in Optimizer button', () => {
    let open;
    let unregister;

    beforeEach(() => {
        mocks.settings = { skillingOptimizer: true, actionPanel_showSort: true };
        mocks.actions = [];
        mocks.skillIcon = null;
        open = vi.fn(async () => true);
        unregister = registerOptimizerOpener({
            supports: (hrid) => hrid !== '/skills/enhancing',
            open,
        });
    });

    afterEach(() => {
        unregister();
        actionFilter.clearFilter();
        document.body.innerHTML = '';
    });

    it('is shown while the Optimizer is running and supports the skill', () => {
        actionFilter.injectFilterInput(makeTitle());
        expect(buttons()).toHaveLength(1);
        expect(buttons()[0].style.display).toBe('');
    });

    it('is hidden when the Optimizer setting is off', () => {
        mocks.settings.skillingOptimizer = false;
        actionFilter.injectFilterInput(makeTitle());
        expect(buttons()[0].style.display).toBe('none');
    });

    it('is hidden when the Optimizer is not running (no registration)', () => {
        unregister();
        actionFilter.injectFilterInput(makeTitle());
        expect(buttons()[0].style.display).toBe('none');
    });

    it('is hidden for a skill the Optimizer has no view for, read from the icon not the name', () => {
        mocks.skillIcon = 'enhancing';
        actionFilter.injectFilterInput(makeTitle('Woodcutting'));
        expect(buttons()[0].style.display).toBe('none');
    });

    it('click passes the skill hrid with no action when nothing of that skill is running', async () => {
        actionFilter.injectFilterInput(makeTitle());
        buttons()[0].click();
        await Promise.resolve();
        expect(open).toHaveBeenCalledWith('/skills/woodcutting', null);
    });

    it("click passes the running action of this skill, but not another skill's", async () => {
        actionFilter.injectFilterInput(makeTitle());
        mocks.actions = [{ actionHrid: '/actions/woodcutting/tree', isDone: false }];
        buttons()[0].click();
        await Promise.resolve();
        expect(open).toHaveBeenLastCalledWith('/skills/woodcutting', '/actions/woodcutting/tree');

        mocks.actions = [{ actionHrid: '/actions/milking/cow', isDone: false }];
        buttons()[0].click();
        await Promise.resolve();
        expect(open).toHaveBeenLastCalledWith('/skills/woodcutting', null);
    });

    it('re-injecting into the same or a new title leaves exactly one button', () => {
        const first = makeTitle();
        actionFilter.injectFilterInput(first);
        actionFilter.injectFilterInput(first);
        expect(buttons()).toHaveLength(1);
        first.remove();
        actionFilter.injectFilterInput(makeTitle('Foraging'));
        expect(buttons()).toHaveLength(1);
    });
});
