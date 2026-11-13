/** @vitest-environment happy-dom */

/**
 * Production tiles with simulated scrolls (the other tile writer: max-produceable draws the production tiles'
 * Profit/hr, Exp/hr and Eff. XP/hr and feeds the shared sort). Same rules as the gathering tiles: the tile and
 * the sort use the scrolls, the cache keeps the real figures, the tile says what it assumes, and off or nothing
 * chosen gives back the real tile.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    settings: {},
    listeners: {},
    profitCalls: [],
    expCalls: [],
    profit: null,
    exp: null,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#0ff',
        COLOR_BORDER: '#444',
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
        COLOR_WARNING: '#ff0',
        SCRIPT_COLOR_ALERT: '#fa0',
        getSetting: (key) => game.settings[key],
        getSettingValue: (_k, fallback) => fallback,
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
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: async () => {}, getPrice: () => null, on: () => () => {} },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getSnapshotInfoForSkill: () => null, onUpdate: () => {}, offUpdate: () => {} },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    scrollSimulator: () => null,
    loadoutSnapshot: () => null,
    scrollPlannerInstance: () => null,
}));
vi.mock('./action-filter.js', () => ({ default: { isFilterHidden: () => false } }));
vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('./production-profit.js', () => ({
    calculateProductionProfit: async (hrid, options) => game.profit(hrid, options),
}));
vi.mock('../../utils/experience-calculator.js', () => ({ calculateExpPerHour: (hrid) => game.exp(hrid) }));
vi.mock('../../utils/tea-parser.js', () => ({ parseArtisanBonus: () => 0, getDrinkConcentration: () => 0 }));

const dataManager = (await import('../../core/data-manager.js')).default;
const scrollSimulator = (await import('../combat/scroll-simulator.js')).default;
const actionPanelSort = (await import('./action-panel-sort.js')).default;
const maxProduceable = (await import('./max-produceable.js')).default;
const { TILE_SCROLLS_SETTING } = await import('./tile-scrolls.js');

const BREWING = '/action_types/brewing';
const HRID = '/actions/brewing/tea';
const EFFICIENCY = '/buff_types/efficiency';

const profitFor = (_hrid, options) => {
    const eff = dataManager.getPersonalBuffFlatBoost(BREWING, EFFICIENCY);
    game.profitCalls.push({ eff, keepSellTax: Boolean(options?.keepSellTax) });
    return { profitPerHour: 1000 + 10000 * eff, hasMissingPrices: false, excludeSellTax: false };
};
const expFor = () => {
    const eff = dataManager.getPersonalBuffFlatBoost(BREWING, EFFICIENCY);
    game.expCalls.push(eff);
    return { expPerHour: 500 + 5000 * eff };
};

const choose = (...hrids) => {
    scrollSimulator.scrollsByLoadout = { __default__: new Set(hrids) };
};
const text = (display, stat) => display.querySelector(`[data-stat="${stat}"]`)?.textContent;

async function renderTile() {
    const panel = document.createElement('div');
    const display = document.createElement('div');
    document.body.appendChild(panel);
    maxProduceable.actionElements.set(panel, { actionHrid: HRID, displayElement: display });
    actionPanelSort.registerPanel(panel, HRID);
    await maxProduceable.updateCount(panel, new Map());
    return { panel, display };
}

beforeEach(() => {
    game.settings = {
        simulateScrollEffects: true,
        [TILE_SCROLLS_SETTING]: true,
        actionPanel_maxProduceable: true,
        actionPanel_showProfitPerHour_production: true,
        actionPanel_showExpPerHour_production: true,
    };
    game.listeners = {};
    game.profitCalls = [];
    game.expCalls = [];
    game.profit = profitFor;
    game.exp = expFor;
    dataManager.scrollSimulationByActionType = {};
    dataManager.personalActionTypeBuffsMap = {};
    vi.spyOn(dataManager, 'getInitClientData').mockReturnValue({
        personalBuffTypeDetailMap: {
            '/personal_buff_types/efficiency': {
                usableInActionTypeMap: { [BREWING]: true },
                buff: { typeHrid: EFFICIENCY, flatBoost: 0.14 },
            },
        },
    });
    vi.spyOn(dataManager, 'getActionDetails').mockReturnValue({ type: BREWING, name: 'Tea' });
    vi.spyOn(dataManager, 'getInventory').mockReturnValue([]);
    vi.spyOn(maxProduceable, 'calculateMaxProduceable').mockReturnValue(5);
    vi.spyOn(maxProduceable, 'fitLineFontSizes').mockImplementation(() => {});
    actionPanelSort.panels.clear();
    actionPanelSort.cachedStats = {};
    maxProduceable.actionElements.clear();
    choose();
});

describe('production tile with simulated scrolls', () => {
    test('the tile and the sort use the chosen scroll; the cache keeps the real figures', async () => {
        choose(EFFICIENCY);
        const { panel, display } = await renderTile();
        expect(text(display, 'profit')).toContain('Profit/hr: 2.4K');
        expect(text(display, 'profit')).toContain('📜');
        expect(text(display, 'exp')).toContain('Exp/hr: 1.2K');
        expect(text(display, 'overall')).toContain('Eff. XP/hr: 1.2K');
        expect(text(display, 'overall')).toContain('📜');
        expect(display.title).toContain('Efficiency scroll');
        expect(actionPanelSort.panels.get(panel).profitPerHour).toBeCloseTo(2400);
        expect(actionPanelSort.panels.get(panel).expPerHour).toBeCloseTo(1200);
        expect(actionPanelSort.getCachedStats(HRID).profitPerHour).toBeCloseTo(1000);
        expect(actionPanelSort.getCachedStats(HRID).expPerHour).toBeCloseTo(500);
        expect(dataManager.scrollSimulationByActionType[BREWING]).toBeUndefined();
    });

    test('the real twin runs with the scroll off', async () => {
        choose(EFFICIENCY);
        await renderTile();
        expect(game.profitCalls).toEqual([
            { eff: 0.14, keepSellTax: false },
            { eff: 0, keepSellTax: true },
        ]);
        expect(game.expCalls).toEqual([0.14, 0]);
    });

    test('the tile setting off, or nothing chosen: exactly the real tile', async () => {
        choose(EFFICIENCY);
        game.settings[TILE_SCROLLS_SETTING] = false;
        const first = await renderTile();
        const { panel } = first;
        let { display } = first;
        expect(text(display, 'profit')).toBe('Profit/hr: 1.0K');
        expect(display.title).toBe('');
        expect(actionPanelSort.panels.get(panel).profitPerHour).toBeCloseTo(1000);
        expect(game.profitCalls).toEqual([{ eff: 0, keepSellTax: false }]);

        game.settings[TILE_SCROLLS_SETTING] = true;
        choose();
        ({ display } = await renderTile());
        expect(text(display, 'profit')).toBe('Profit/hr: 1.0K');
        expect(display.title).toBe('');
    });

    test('a scroll already active in the game is not counted twice or marked', async () => {
        choose(EFFICIENCY);
        dataManager.personalActionTypeBuffsMap = { [BREWING]: [{ typeHrid: EFFICIENCY, flatBoost: 0.14 }] };
        const { panel, display } = await renderTile();
        expect(actionPanelSort.panels.get(panel).profitPerHour).toBeCloseTo(2400);
        expect(text(display, 'profit')).not.toContain('📜');
        expect(display.title).toBe('');
    });

    test('a changed choice redraws the tile and the best-action pass keeps the mark', async () => {
        const { display } = await renderTile();
        expect(text(display, 'profit')).toBe('Profit/hr: 1.0K');
        choose(EFFICIENCY);
        await maxProduceable.updateAllCounts();
        expect(text(display, 'profit')).toContain('Profit/hr: 2.4K');
        maxProduceable.addBestActionIndicators();
        expect(text(display, 'overall')).toContain('📜');
        expect(text(display, 'overall')).toContain('🏆');
    });

    test('initialize redraws on a changed choice and stops when disabled', async () => {
        vi.useFakeTimers();
        try {
            await maxProduceable.initialize();
            const update = vi.spyOn(maxProduceable, 'updateAllCounts').mockResolvedValue();
            document.dispatchEvent(new CustomEvent('toolasha:scroll-selection-changed'));
            document.dispatchEvent(new CustomEvent('toolasha:scroll-selection-changed'));
            vi.advanceTimersByTime(60);
            expect(update).toHaveBeenCalledTimes(1);
            maxProduceable.disable();
            document.dispatchEvent(new CustomEvent('toolasha:scroll-selection-changed'));
            vi.advanceTimersByTime(60);
            expect(update).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
