/**
 * @vitest-environment happy-dom
 *
 * The pinned list once combat zones are in it.
 *
 * A pinned action's numbers are computed live; a combat zone's come from a
 * simulation that finished at some point, in gear that may since have changed.
 * These tests are about the row shape that lets the two sit in one sorted table
 * without the older one quietly passing for the fresher one.
 *
 * happy-dom (rather than the repo's default `node`) only because one describe
 * block below — "a combat row's click" — renders the actual table and clicks a
 * real row: that click handler is inline inside `renderOverviewTab` and is not
 * exported on its own, so exercising it means building the DOM.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// The snapshot readers live on the combat sim panel, which brings a floating
// panel and two inventory panels with it — none of which this file is about
vi.mock('../combat-sim/combat-sim-ui.js', () => ({
    default: {
        loadAllZonesSnapshot: async () => null,
        currentGearFingerprint: async () => null,
    },
}));

// The row click handler's own navigation calls — spied on rather than left real,
// since this file is about which one a combat row reaches, not what either does.
const mockCombatZoneOpen = vi.hoisted(() => ({
    openCombatZoneAtTier: vi.fn(),
}));
vi.mock('../../utils/combat-zone-open.js', () => ({
    openCombatZoneAtTier: mockCombatZoneOpen.openCombatZoneAtTier,
}));

// The manifest fetch is a real network call in production; loadActions' progressive-
// render tests only care that it doesn't block the first paint, not what it fetches.
vi.mock('../../utils/asset-manifest.js', () => ({
    default: { getSpriteUrl: async () => null },
}));

// Mutated per test — see `src/features/ui/combat-level-panel.test.js`'s pattern:
// mock the game, not the panel, so each test decides what's pinned and what's cached.
const mockDataManager = vi.hoisted(() => ({
    actionDetails: {},
    itemDetails: {},
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: (actionHrid) => mockDataManager.actionDetails[actionHrid] ?? null,
        getItemDetails: (itemHrid) => mockDataManager.itemDetails[itemHrid] ?? null,
    },
}));

const mockActionPanelSort = vi.hoisted(() => ({
    pinned: [],
    cachedStats: {},
}));
vi.mock('./action-panel-sort.js', () => ({
    default: {
        getPinnedActions: () => mockActionPanelSort.pinned,
        getCachedStats: (key) => mockActionPanelSort.cachedStats[key] ?? null,
        onPinChange: () => {},
        offPinChange: () => {},
    },
}));

// _computeAlchemyStats dispatches to the calculator by alchemy type; stubbed rather than
// left real so the routing tests below assert which method was called, not what it returns.
const mockAlchemyCalculator = vi.hoisted(() => ({
    coinify: vi.fn(),
    decompose: vi.fn(),
    transmute: vi.fn(),
    unrefine: vi.fn(),
}));
vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: {
        calculateCoinifyProfit: (...args) => mockAlchemyCalculator.coinify(...args),
        calculateDecomposeProfit: (...args) => mockAlchemyCalculator.decompose(...args),
        calculateTransmuteProfit: (...args) => mockAlchemyCalculator.transmute(...args),
        calculateUnrefineProfit: (...args) => mockAlchemyCalculator.unrefine(...args),
    },
}));
// The XP formula itself is alchemy-rankings.test.js's job; here it only needs to be callable.
const mockCalcXpPerAction = vi.hoisted(() => vi.fn(() => 100));
vi.mock('../alchemy/alchemy-rankings.js', () => ({ calcXpPerAction: (...args) => mockCalcXpPerAction(...args) }));

const { default: page, combatZoneRows, formatAge } = await import('./pinned-actions-page.js');

const SNAPSHOT = {
    version: 1,
    savedAt: 1700000000000,
    hours: 10,
    fingerprint: 'gear-a',
    zones: [
        {
            zoneHrid: '/actions/combat/fly',
            zoneName: 'Fly',
            difficultyTier: 0,
            profitPerHour: 5000,
            xpPerHour: 12000,
        },
        {
            zoneHrid: '/actions/combat/jungle',
            zoneName: 'Jungle',
            difficultyTier: 2,
            profitPerHour: null,
            xpPerHour: 30000,
        },
    ],
};

describe('combatZoneRows', () => {
    test('a zone reads like a pinned action, with its tier in the name and key', () => {
        const [fly, jungle] = combatZoneRows(SNAPSHOT, 'gear-a');

        expect(fly).toMatchObject({
            actionHrid: '/actions/combat/fly|T0',
            baseActionHrid: '/actions/combat/fly',
            name: 'Fly T0',
            skill: 'Combat',
            profitPerHour: 5000,
            expPerHour: 12000,
            source: 'combat-sim',
            simulatedAt: 1700000000000,
        });
        expect(jungle.actionHrid).toBe('/actions/combat/jungle|T2');
        expect(jungle.name).toBe('Jungle T2');
    });

    test('an unpriced zone carries null rather than a zero it did not measure', () => {
        expect(combatZoneRows(SNAPSHOT, 'gear-a')[1].profitPerHour).toBeNull();
    });

    test('gear matching the run is not flagged', () => {
        expect(combatZoneRows(SNAPSHOT, 'gear-a').every((row) => row.gearChanged === false)).toBe(true);
    });

    test('gear that has moved since flags every row from that run', () => {
        expect(combatZoneRows(SNAPSHOT, 'gear-b').every((row) => row.gearChanged === true)).toBe(true);
    });

    test('an unknown fingerprint on either side is not evidence of a change', () => {
        expect(combatZoneRows(SNAPSHOT, null)[0].gearChanged).toBe(false);
        expect(combatZoneRows({ ...SNAPSHOT, fingerprint: null }, 'gear-b')[0].gearChanged).toBe(false);
    });

    test('nothing stored is no rows rather than a throw', () => {
        expect(combatZoneRows(null, 'gear-a')).toEqual([]);
        expect(combatZoneRows({}, 'gear-a')).toEqual([]);
    });

    test('the tier lives on the row, not just in its name or key', () => {
        const [fly, jungle] = combatZoneRows(SNAPSHOT, 'gear-a');
        expect(fly.difficultyTier).toBe(0);
        expect(jungle.difficultyTier).toBe(2);
    });
});

describe('a combat row click', () => {
    // `getGameObject()` (module-private) walks `#root`'s React fiber tree —
    // this is the same shape `navigateToAction`/`item-navigation.js` measured live.
    function mountReactRoot(handleGoToAction) {
        document.getElementById('root')?.remove();
        const root = document.createElement('div');
        root.id = 'root';
        root._reactRootContainer = { current: { stateNode: { handleGoToAction }, child: null, sibling: null } };
        document.body.appendChild(root);
        return root;
    }

    beforeEach(() => {
        mockCombatZoneOpen.openCombatZoneAtTier.mockReset();
        page.selectedSkills = [];
        page.sortColumn = 'name';
        page.sortDirection = 'asc';
        page.activeTab = 'overview';
        page.itemsSpriteUrl = null;
        page.isActive = true;
        page.hiddenElements = [];
        page.pageContainer = document.createElement('div');
        document.body.appendChild(page.pageContainer);
    });

    afterEach(() => {
        document.getElementById('root')?.remove();
        page.pageContainer?.remove();
        page.pageContainer = null;
        page.contentArea = null;
        page.isActive = false;
        page.allActions = [];
        vi.restoreAllMocks();
    });

    test('a combat-sim row opens its own tier through openCombatZoneAtTier, not handleGoToAction', async () => {
        mockCombatZoneOpen.openCombatZoneAtTier.mockResolvedValue({ opened: true, tierConfirmed: true, filled: false });
        const goTo = vi.fn();
        mountReactRoot(goTo);

        page.allActions = combatZoneRows(SNAPSHOT, 'gear-a');
        page.renderTable();

        const jungleRow = page.contentArea.querySelector('[data-action-hrid="/actions/combat/jungle|T2"]');
        expect(jungleRow).toBeTruthy();
        jungleRow.dispatchEvent(new Event('click', { bubbles: true }));

        // Row's own tier (2), read off the row — never re-derived from the name or key
        expect(mockCombatZoneOpen.openCombatZoneAtTier).toHaveBeenCalledWith('/actions/combat/jungle', 2);
        expect(goTo).not.toHaveBeenCalled();

        // Not hidden yet — the open is still in flight
        expect(page.isActive).toBe(true);

        await Promise.resolve();
        await Promise.resolve();

        // Hidden only once the zone actually opened
        expect(page.isActive).toBe(false);
    });

    test('a combat-sim row that fails to open leaves the pinned page up rather than stranding the player', async () => {
        mockCombatZoneOpen.openCombatZoneAtTier.mockResolvedValue({
            opened: false,
            tierConfirmed: false,
            filled: false,
        });
        mountReactRoot(vi.fn());

        page.allActions = combatZoneRows(SNAPSHOT, 'gear-a');
        page.renderTable();

        const flyRow = page.contentArea.querySelector('[data-action-hrid="/actions/combat/fly|T0"]');
        flyRow.dispatchEvent(new Event('click', { bubbles: true }));

        await Promise.resolve();
        await Promise.resolve();

        expect(page.isActive).toBe(true);
    });

    test('a non-combat row is untouched: still handleGoToAction, still hidden synchronously', () => {
        const handleGoToAction = vi.fn();
        mountReactRoot(handleGoToAction);

        page.allActions = [
            {
                actionHrid: '/actions/milking/cow',
                baseActionHrid: '/actions/milking/cow',
                name: 'Milk Cow',
                skill: 'Milking',
                type: '/action_types/milking',
                level: 1,
                profitPerHour: 6000,
                expPerHour: 100,
            },
        ];
        page.renderTable();

        const row = page.contentArea.querySelector('[data-action-hrid="/actions/milking/cow"]');
        expect(row).toBeTruthy();
        row.dispatchEvent(new Event('click', { bubbles: true }));

        expect(handleGoToAction).toHaveBeenCalledWith('/actions/milking/cow');
        expect(mockCombatZoneOpen.openCombatZoneAtTier).not.toHaveBeenCalled();
        // Hidden immediately — no async step in this path
        expect(page.isActive).toBe(false);
    });
});

describe('the merged table', () => {
    test('sorts simulated zones against live actions on the same column', () => {
        const milking = {
            actionHrid: '/actions/milking/cow',
            name: 'Milk Cow',
            skill: 'Milking',
            type: '/action_types/milking',
            level: 1,
            profitPerHour: 6000,
            expPerHour: 100,
        };

        page.allActions = [milking, ...combatZoneRows(SNAPSHOT, 'gear-a')];
        page.selectedSkills = [];
        page.sortColumn = 'profitPerHour';
        page.sortDirection = 'desc';

        const sorted = page.getFilteredSorted();

        expect(sorted.map((row) => row.name)).toEqual(['Milk Cow', 'Fly T0', 'Jungle T2']);
        // The unpriced zone sorts last either way rather than reading as free
        page.sortDirection = 'asc';
        expect(page.getFilteredSorted().at(-1).name).toBe('Jungle T2');

        page.allActions = [];
    });

    test('the skill filter can single out the simulated rows', () => {
        page.allActions = [
            { actionHrid: '/actions/milking/cow', name: 'Milk Cow', skill: 'Milking', profitPerHour: 1, expPerHour: 1 },
            ...combatZoneRows(SNAPSHOT, 'gear-a'),
        ];
        page.selectedSkills = ['Combat'];
        page.sortColumn = 'name';
        page.sortDirection = 'asc';

        expect(page.getFilteredSorted().map((row) => row.name)).toEqual(['Fly T0', 'Jungle T2']);

        page.selectedSkills = [];
        page.allActions = [];
    });

    test('a row still being measured sorts last rather than as a zero', () => {
        // A pending row carries `profitPerHour: null`, same as a resolved-but-unpriced
        // one — it must not land between the loss and the profit the way an actual
        // zero would.
        page.allActions = [
            { actionHrid: 'a', name: 'Loss', skill: 'Milking', profitPerHour: -500, expPerHour: 10 },
            {
                actionHrid: 'b',
                name: 'Measuring',
                skill: 'Milking',
                profitPerHour: null,
                expPerHour: null,
                pending: true,
            },
            { actionHrid: 'c', name: 'Profit', skill: 'Milking', profitPerHour: 500, expPerHour: 10 },
        ];
        page.selectedSkills = [];
        page.sortColumn = 'profitPerHour';

        page.sortDirection = 'desc';
        expect(page.getFilteredSorted().map((row) => row.name)).toEqual(['Profit', 'Loss', 'Measuring']);

        page.sortDirection = 'asc';
        expect(page.getFilteredSorted().map((row) => row.name)).toEqual(['Loss', 'Profit', 'Measuring']);

        page.allActions = [];
    });
});

describe('loadActions', () => {
    const ACTION_HRID = '/actions/tailoring/artificer_cape_refined';
    const ITEM_HRID = '/items/artificer_cape';

    beforeEach(() => {
        mockDataManager.actionDetails = {
            [ACTION_HRID]: {
                name: 'Artificer Cape',
                type: '/action_types/tailoring',
                levelRequirement: { level: 45 },
                outputItems: [{ itemHrid: ITEM_HRID }],
            },
        };
        mockDataManager.itemDetails = {};
        mockActionPanelSort.pinned = [ACTION_HRID];
        mockActionPanelSort.cachedStats = {};
        page.allActions = [];
        page.itemsSpriteUrl = null;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        page.allActions = [];
        page.itemsSpriteUrl = null;
    });

    test('a cold row paints as pending before computeStats resolves, then fills in without a second call', async () => {
        let resolveStats;
        const computeStatsSpy = vi
            .spyOn(page, 'computeStats')
            .mockImplementation(() => new Promise((resolve) => (resolveStats = resolve)));

        const loadPromise = page.loadActions();

        // The synchronous prefix of loadActions (building rows from what's already
        // known) has already run by the time loadActions returns its promise —
        // nothing here has been awaited yet.
        expect(page.allActions).toHaveLength(1);
        expect(page.allActions[0]).toMatchObject({
            actionHrid: ACTION_HRID,
            name: 'Artificer Cape',
            pending: true,
            profitPerHour: null,
            expPerHour: null,
        });
        expect(computeStatsSpy).toHaveBeenCalledTimes(1);

        resolveStats({ profitPerHour: 42_000, expPerHour: 1_200, liquidityLimit: null });
        await loadPromise;

        expect(page.allActions[0]).toMatchObject({
            pending: false,
            profitPerHour: 42_000,
            expPerHour: 1_200,
        });
    });

    test('a warm row (already cached) never calls computeStats and never shows as pending', async () => {
        mockActionPanelSort.cachedStats[ACTION_HRID] = {
            profitPerHour: 9_000,
            expPerHour: 300,
            liquidityLimit: null,
            liquidityChecked: true,
        };
        const computeStatsSpy = vi.spyOn(page, 'computeStats');

        await page.loadActions();

        expect(computeStatsSpy).not.toHaveBeenCalled();
        expect(page.allActions[0]).toMatchObject({
            pending: false,
            profitPerHour: 9_000,
            expPerHour: 300,
        });
    });

    test('a figure cached by the action tiles paints at once, then is replaced by the liquidity-capped one', async () => {
        // The tiles cache an uncapped profit/hr; ranking pins by it let a row the player had
        // browsed past outrank the same row computed here, which is capped by market volume
        mockActionPanelSort.cachedStats[ACTION_HRID] = { profitPerHour: 900_000, expPerHour: 300 };
        let resolveStats;
        const computeStatsSpy = vi
            .spyOn(page, 'computeStats')
            .mockImplementation(() => new Promise((resolve) => (resolveStats = resolve)));

        const loadPromise = page.loadActions();

        expect(page.allActions[0]).toMatchObject({ pending: false, profitPerHour: 900_000 });
        expect(computeStatsSpy).toHaveBeenCalledTimes(1);

        const limit = { kind: 'volume' };
        resolveStats({ profitPerHour: 120_000, expPerHour: 300, liquidityLimit: limit, liquidityChecked: true });
        await loadPromise;

        expect(page.allActions[0]).toMatchObject({ pending: false, profitPerHour: 120_000, liquidityLimit: limit });
    });

    test('a row whose stats call rejects settles as unpriced rather than staying pending forever', async () => {
        // computeStats already catches everything itself and resolves null on
        // failure — this pins the second net around it: even a rejection reaching
        // loadActions some other way must not leave the row stuck "measuring…" or
        // take the rest of the page's rows down with it via Promise.all.
        vi.spyOn(page, 'computeStats').mockRejectedValue(new Error('network'));
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(page.loadActions()).resolves.toBeUndefined();

        expect(page.allActions[0]).toMatchObject({ pending: false, profitPerHour: null, expPerHour: null });
    });
});

describe('formatAge', () => {
    const NOW = 1700000000000;

    test('says how stale a run is in terms worth acting on', () => {
        expect(formatAge(NOW - 5 * 60_000, NOW)).toBe('5m ago');
        expect(formatAge(NOW - 3 * 3600_000, NOW)).toBe('3h ago');
        expect(formatAge(NOW - 5 * 24 * 3600_000, NOW)).toBe('5d ago');
    });

    test('no timestamp says nothing rather than 1970', () => {
        expect(formatAge(null, NOW)).toBe('');
    });
});

describe('_computeAlchemyStats', () => {
    const ITEM_HRID = '/items/refined_plate';

    beforeEach(() => {
        mockAlchemyCalculator.coinify.mockReset();
        mockAlchemyCalculator.decompose.mockReset();
        mockAlchemyCalculator.transmute.mockReset();
        mockAlchemyCalculator.unrefine.mockReset();
        mockDataManager.itemDetails[ITEM_HRID] = { itemLevel: 50 };
    });

    test('a pinned Unrefine action is priced through calculateUnrefineProfit, not Coinify', () => {
        mockAlchemyCalculator.unrefine.mockReturnValue({
            profitPerHour: 1234,
            actionsPerHour: 100,
            successRate: 1,
        });

        const stats = page._computeAlchemyStats('unrefine', ITEM_HRID);

        expect(mockAlchemyCalculator.unrefine).toHaveBeenCalledWith(ITEM_HRID, 0);
        expect(mockAlchemyCalculator.coinify).not.toHaveBeenCalled();
        expect(stats).toMatchObject({ profitPerHour: 1234, expPerHour: 100 * 100 });
    });

    test('a pinned Coinify action still routes to calculateCoinifyProfit', () => {
        mockAlchemyCalculator.coinify.mockReturnValue({
            profitPerHour: 500,
            actionsPerHour: 10,
            successRate: 0.7,
        });

        page._computeAlchemyStats('coinify', ITEM_HRID);

        expect(mockAlchemyCalculator.coinify).toHaveBeenCalledWith(ITEM_HRID, 0);
        expect(mockAlchemyCalculator.unrefine).not.toHaveBeenCalled();
    });

    test('a level-less item earns XP at level 0, as Best Items and the action panel read it', () => {
        mockDataManager.itemDetails[ITEM_HRID] = {};
        mockAlchemyCalculator.decompose.mockReturnValue({ profitPerHour: 1, actionsPerHour: 1, successRate: 0.5 });
        mockCalcXpPerAction.mockClear();

        page._computeAlchemyStats('decompose', ITEM_HRID);

        expect(mockCalcXpPerAction).toHaveBeenCalledWith('decompose', 0, 0.5);
    });

    test('an unpriceable Unrefine item answers null rather than throwing', () => {
        mockAlchemyCalculator.unrefine.mockReturnValue(null);
        expect(page._computeAlchemyStats('unrefine', ITEM_HRID)).toBeNull();
    });
});
