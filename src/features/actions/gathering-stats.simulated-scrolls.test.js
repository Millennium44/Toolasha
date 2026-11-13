/** @vitest-environment happy-dom */

/**
 * Gathering tiles with simulated scrolls: the tile figures and the sort use the scrolls, the shared cache that
 * task cards and the pinned page read keeps the real figures, the tile says what it assumes, and turning the
 * setting off or choosing nothing gives back exactly the real tile.
 *
 * The data manager, tile-scrolls and the sort manager are the real ones; the calculators are stand-ins that
 * read the efficiency buff the way the real ones do (through `getPersonalBuffFlatBoost`), so the figure moves
 * only when the simulation is armed.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    settings: {},
    listeners: {},
    profitCalls: [],
    expCalls: [],
    excludeSellTax: false,
    profit: null,
    exp: null,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#0ff',
        COLOR_BORDER: '#444',
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
        getSetting: (key) => game.settings[key],
        onSettingChange: (key, cb) => {
            (game.listeners[key] ||= new Set()).add(cb);
            return () => game.listeners[key].delete(cb);
        },
        offSettingChange: () => {},
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (_k, _s, d) => d,
        get: async (_k, _s, d) => d,
        set: async () => {},
        setJSON: async () => {},
    },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getSnapshotInfoForSkill: () => null, onUpdate: () => {}, offUpdate: () => {} },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    scrollSimulator: () => null,
    loadoutSnapshot: () => null,
    scrollPlannerInstance: () => null,
    guildMemberSkills: () => null,
    marketUndercutAlerts: () => null,
}));
vi.mock('./action-filter.js', () => ({ default: { isFilterHidden: () => false } }));
vi.mock('./gathering-profit.js', () => ({
    // No await before the arithmetic, like the real one: the figure is fixed when the call starts
    calculateGatheringProfit: async (hrid, options) => game.profit(hrid, options),
}));
vi.mock('../../utils/experience-calculator.js', () => ({ calculateExpPerHour: (hrid) => game.exp(hrid) }));
vi.mock('../../utils/action-panel-helper.js', () => ({ onActionTile: () => () => {}, resolveActionTile: () => null }));

const dataManager = (await import('../../core/data-manager.js')).default;
const scrollSimulator = (await import('../combat/scroll-simulator.js')).default;
const actionPanelSort = (await import('./action-panel-sort.js')).default;
const stats = (await import('./gathering-stats.js')).default;
const { TILE_SCROLLS_SETTING } = await import('./tile-scrolls.js');

const MILKING = '/action_types/milking';
const HRID = '/actions/milking/cow';
const EFFICIENCY = '/buff_types/efficiency';

// Profit is 1000 plus 10000 per point of efficiency; exp is 500 plus 5000 per point
const profitFor = (_hrid, options) => {
    const eff = dataManager.getPersonalBuffFlatBoost(MILKING, EFFICIENCY);
    game.profitCalls.push({ eff, keepSellTax: Boolean(options?.keepSellTax) });
    return { profitPerHour: 1000 + 10000 * eff, hasMissingPrices: false, excludeSellTax: game.excludeSellTax };
};
const expFor = () => {
    const eff = dataManager.getPersonalBuffFlatBoost(MILKING, EFFICIENCY);
    game.expCalls.push(eff);
    return { expPerHour: 500 + 5000 * eff };
};

function choose(...hrids) {
    scrollSimulator.scrollsByLoadout = { __default__: new Set(hrids) };
}

async function renderTile() {
    const panel = document.createElement('div');
    const display = document.createElement('div');
    document.body.appendChild(panel);
    stats.actionElements.set(panel, { actionHrid: HRID, displayElement: display });
    actionPanelSort.registerPanel(panel, HRID);
    vi.spyOn(stats, 'fitLineFontSizes').mockImplementation(() => {});
    await stats.updateStats(panel);
    return { panel, display };
}

const text = (display, stat) => display.querySelector(`[data-stat="${stat}"]`)?.textContent;

beforeEach(() => {
    game.settings = {
        simulateScrollEffects: true,
        [TILE_SCROLLS_SETTING]: true,
        actionPanel_showProfitPerHour_gathering: true,
        actionPanel_showExpPerHour_gathering: true,
    };
    game.listeners = {};
    game.profitCalls = [];
    game.expCalls = [];
    game.excludeSellTax = false;
    game.profit = profitFor;
    game.exp = expFor;
    dataManager.scrollSimulationByActionType = {};
    dataManager.personalActionTypeBuffsMap = {};
    vi.spyOn(dataManager, 'getInitClientData').mockReturnValue({
        personalBuffTypeDetailMap: {
            '/personal_buff_types/efficiency': {
                usableInActionTypeMap: { [MILKING]: true },
                buff: { typeHrid: EFFICIENCY, flatBoost: 0.14 },
            },
        },
    });
    vi.spyOn(dataManager, 'getActionDetails').mockReturnValue({ type: MILKING, name: 'Cow' });
    actionPanelSort.panels.clear();
    actionPanelSort.cachedStats = {};
    stats.actionElements.clear();
    choose();
});

describe('gathering tile with simulated scrolls', () => {
    test('with a scroll chosen the tile, the sort and the marks use it; the cache keeps the real figures', async () => {
        choose(EFFICIENCY);
        const { panel, display } = await renderTile();
        // 0.14 efficiency: profit 1000 + 1400, exp 500 + 700
        expect(text(display, 'profit')).toContain('Profit/hr: 2.4K');
        expect(text(display, 'profit')).toContain('📜');
        expect(text(display, 'exp')).toContain('Exp/hr: 1.2K');
        expect(text(display, 'exp')).toContain('📜');
        expect(text(display, 'overall')).toContain('Eff. XP/hr: 1.2K');
        expect(display.title).toContain('Efficiency scroll');
        expect(display.dataset.mwiSimulatedScrolls).toBe('Efficiency');
        // The sort reads the figures the tile shows
        expect(actionPanelSort.panels.get(panel).profitPerHour).toBeCloseTo(2400);
        expect(actionPanelSort.panels.get(panel).expPerHour).toBeCloseTo(1200);
        // The cache (task cards, the pinned page) is the real, scroll-free figure
        expect(actionPanelSort.getCachedStats(HRID).profitPerHour).toBeCloseTo(1000);
        expect(actionPanelSort.getCachedStats(HRID).expPerHour).toBeCloseTo(500);
        // Nothing is left armed
        expect(dataManager.scrollSimulationByActionType[MILKING]).toBeUndefined();
    });

    test('the real twin is computed with the scroll off, even beside a simulated tile', async () => {
        choose(EFFICIENCY);
        await renderTile();
        expect(game.profitCalls).toEqual([
            { eff: 0.14, keepSellTax: false },
            { eff: 0, keepSellTax: true },
        ]);
        expect(game.expCalls).toEqual([0.14, 0]);
    });

    test('the tile setting off: exactly the real tile, no mark, one calculation', async () => {
        choose(EFFICIENCY);
        game.settings[TILE_SCROLLS_SETTING] = false;
        const { panel, display } = await renderTile();
        expect(text(display, 'profit')).toBe('Profit/hr: 1.0K');
        expect(text(display, 'exp')).toBe('Exp/hr: 500');
        expect(display.title).toBe('');
        expect(display.dataset.mwiSimulatedScrolls).toBeUndefined();
        expect(actionPanelSort.panels.get(panel).profitPerHour).toBeCloseTo(1000);
        expect(game.profitCalls).toEqual([{ eff: 0, keepSellTax: false }]);
    });

    test('the simulation switch off, or nothing chosen: the real tile', async () => {
        choose(EFFICIENCY);
        game.settings.simulateScrollEffects = false;
        let { display } = await renderTile();
        expect(text(display, 'profit')).toBe('Profit/hr: 1.0K');
        expect(display.title).toBe('');

        game.settings.simulateScrollEffects = true;
        choose();
        ({ display } = await renderTile());
        expect(text(display, 'profit')).toBe('Profit/hr: 1.0K');
        expect(display.title).toBe('');
    });

    test('a scroll already active in the game is not counted twice, and the tile is not marked', async () => {
        choose(EFFICIENCY);
        dataManager.personalActionTypeBuffsMap = { [MILKING]: [{ typeHrid: EFFICIENCY, flatBoost: 0.14 }] };
        const { panel, display } = await renderTile();
        // The game's own 0.14 is already in the real figures: 1000 + 1400 either way
        expect(actionPanelSort.panels.get(panel).profitPerHour).toBeCloseTo(2400);
        expect(text(display, 'profit')).not.toContain('📜');
        expect(display.title).toBe('');
        expect(game.profitCalls).toEqual([{ eff: 0.14, keepSellTax: false }]);
    });

    test('a choice changing while the page is open redraws the tile; the setting off puts the real one back', async () => {
        const { display } = await renderTile();
        expect(text(display, 'profit')).toBe('Profit/hr: 1.0K');

        choose(EFFICIENCY);
        await stats.updateAllStats();
        expect(text(display, 'profit')).toContain('Profit/hr: 2.4K');
        expect(text(display, 'profit')).toContain('📜');

        game.settings[TILE_SCROLLS_SETTING] = false;
        await stats.updateAllStats();
        expect(text(display, 'profit')).toBe('Profit/hr: 1.0K');
        expect(display.title).toBe('');
        expect(display.style.borderTopStyle).toBe('solid');
    });

    test('the best-action pass keeps the scroll mark on the Eff. XP/hr line', async () => {
        choose(EFFICIENCY);
        const { display } = await renderTile();
        stats.addBestActionIndicators();
        expect(text(display, 'overall')).toContain('📜');
        expect(text(display, 'overall')).toContain('🏆');
    });

    test('the untaxed toggle and simulated scrolls together still cache the real taxed rate', async () => {
        choose(EFFICIENCY);
        game.excludeSellTax = true;
        await renderTile();
        expect(game.profitCalls.at(-1)).toEqual({ eff: 0, keepSellTax: true });
        expect(actionPanelSort.getCachedStats(HRID).profitPerHour).toBeCloseTo(1000);
    });

    test('initialize redraws the tiles when the choice changes and stops when disabled', async () => {
        vi.useFakeTimers();
        try {
            await stats.initialize();
            const update = vi.spyOn(stats, 'updateAllStats').mockResolvedValue();
            document.dispatchEvent(new CustomEvent('toolasha:scroll-selection-changed'));
            document.dispatchEvent(new CustomEvent('toolasha:scroll-selection-changed'));
            vi.advanceTimersByTime(60);
            expect(update).toHaveBeenCalledTimes(1);
            stats.disable();
            document.dispatchEvent(new CustomEvent('toolasha:scroll-selection-changed'));
            vi.advanceTimersByTime(60);
            expect(update).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
