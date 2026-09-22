/** @vitest-environment happy-dom */
/**
 * Coverage for the Equipment Progression sort control.
 *
 * Rows used to render in a fixed slot order, so a two-year-payback item looked exactly as
 * prominent as a genuinely good upgrade. The sort ranks each slot by the same first-beats-
 * baseline upgrade the row itself displays; "Best Value" follows the skill's own optimization
 * goal (XP/hr bought per gold for XP skills, payback for Gold-goal gathering skills).
 *
 * The engine is mocked (as in skilling-optimizer-ui.character-switch.test.js) so each slot's
 * cost is stated as data, letting the ordering be checked by hand.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const engine = vi.hoisted(() => ({ costs: {}, scoreCalls: [] }));

vi.mock('../../core/config.js', () => ({
    default: { COLOR_ACCENT: '#22c55e', COLOR_INFO: '#38bdf8', COLOR_PROFIT: '#22c55e', getSetting: () => true },
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: () => () => {},
}));
vi.mock('./skilling-optimizer-engine.js', () => ({
    calculateSkillPerformance: () => null,
    getSkillActionsForDisplay: () => [],
    getItemsForSlot: () => [],
    getAlchemyItemOptions: () => [],
    buildAchievableEquipment: () => new Map(),
    getSkillDrinkItems: () => [],
    getPlayerSkillLevel: () => 50,
    optimizeSkill: () => null,
    findOptimalTeas: () => null,
    calculateSlotUpgradeCost: (itemHrid) => engine.costs[itemHrid] ?? null,
    SKILL_NAMES: ['Woodcutting'],
    SKILLING_LOCATIONS: [],
    SLOT_DISPLAY_NAMES: {},
    SKILL_TOOL_LOCATION: {},
}));
vi.mock('../../utils/tea-optimizer.js', () => ({
    scoreEquipmentSetup: (...args) => {
        engine.scoreCalls.push(args);
        return 0;
    },
}));
vi.mock('../../utils/house-roi.js', () => ({
    // The House Rooms board is its own module with its own tests; these files are about the
    // equipment list, and the real board would reach for a house and an action queue they
    // do not stand up.
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
    loadoutSnapshot: () => null,
    dataManager: () => null,
}));

const { skillingSimulatorUI: ui } = await import('./skilling-optimizer-ui.js');

const XP_BASELINE = 1000;
const GOLD_BASELINE = 1000;

/**
 * One slot whose single breakpoint recommends `itemName` for the stated gains.
 * @param {string} itemName
 * @param {number} xpGain
 * @param {number} goldGain
 * @returns {[string, Object]} [locationHrid, slotData] pair, as optimizeSkill() returns them
 */
function slot(itemName, xpGain, goldGain) {
    return [
        `/item_locations/${itemName}`,
        {
            name: itemName,
            candidateCount: 1,
            progression: [
                {
                    breakpoint: 0,
                    enhancementLevel: 0,
                    itemHrid: `/items/${itemName}`,
                    itemName,
                    score: XP_BASELINE + xpGain,
                    xpScore: XP_BASELINE + xpGain,
                    goldScore: GOLD_BASELINE + goldGain,
                    isChange: true,
                },
            ],
        },
    ];
}

/**
 * Render a result and read back the order the slot rows came out in.
 * @param {Array} slotPairs
 * @param {string} goal
 * @returns {Array<string>} Slot names, in rendered order
 */
function renderedOrder(slotPairs, goal) {
    const container = document.createElement('div');
    ui._renderOptimizerResults(
        container,
        {
            skill: 'Woodcutting',
            playerLevel: 50,
            goal,
            xpBaseline: XP_BASELINE,
            goldBaseline: GOLD_BASELINE,
            slots: Object.fromEntries(slotPairs),
            goldHasMissingPrices: false,
        },
        null,
        null
    );
    return [...container.querySelectorAll('div')]
        .map((el) => el.textContent)
        .filter((text) => slotPairs.some(([, data]) => text.startsWith(data.name)))
        .map((text) => slotPairs.find(([, data]) => text.startsWith(data.name))[1].name)
        .filter((name, index, all) => all.indexOf(name) === index);
}

// cheap: small cost, small gain. rich: big cost, big gain. dud: big cost, tiny gain.
const SLOTS = [slot('cheap', 100, 100), slot('rich', 1000, 1000), slot('dud', 10, 10)];

beforeEach(() => {
    engine.costs = {
        '/items/cheap': 1_000_000,
        '/items/rich': 5_000_000,
        '/items/dud': 9_000_000,
    };
    engine.scoreCalls = [];
    ui.optimizerSortMode = 'value';
});

describe('Equipment Progression sort control', () => {
    test('offers every sort mode, defaulting to Best Value', () => {
        const container = document.createElement('div');
        const control = ui._makeSortControl(container, { goal: 'xp' }, null, null);
        const select = control.querySelector('select');
        expect([...select.options].map((o) => o.value)).toEqual([
            'value',
            'payback',
            'cost',
            'xpGain',
            'goldGain',
            'xpRatio',
            'profitRatio',
            'slot',
        ]);
        expect(select.value).toBe('value');
    });

    test('Best Value on an XP-goal skill ranks by XP bought per gold', () => {
        // cheap buys 100 XP/hr for 1M; rich 200 per 1M; dud ~1.1 per 1M
        expect(renderedOrder(SLOTS, 'xp')).toEqual(['rich', 'cheap', 'dud']);
    });

    test('Best Value on a Gold-goal skill ranks by payback instead', () => {
        // payback hours: cheap 10K, rich 5K, dud 900K
        expect(renderedOrder(SLOTS, 'gold')).toEqual(['rich', 'cheap', 'dud']);
    });

    test('Payback sorts fastest first regardless of the skill goal', () => {
        ui.optimizerSortMode = 'payback';
        expect(renderedOrder(SLOTS, 'xp')).toEqual(['rich', 'cheap', 'dud']);
    });

    test('Cost sorts cheapest first', () => {
        ui.optimizerSortMode = 'cost';
        expect(renderedOrder(SLOTS, 'xp')).toEqual(['cheap', 'rich', 'dud']);
    });

    test('XP Gain % sorts the largest percentage gain first', () => {
        ui.optimizerSortMode = 'xpGain';
        expect(renderedOrder(SLOTS, 'gold')).toEqual(['rich', 'cheap', 'dud']);
    });

    test('Gold Gain % sorts the largest percentage gain first', () => {
        ui.optimizerSortMode = 'goldGain';
        expect(renderedOrder(SLOTS, 'xp')).toEqual(['rich', 'cheap', 'dud']);
    });

    test('G/0.01% Exp/Hr sorts the cheapest fixed percentage-point gain first', () => {
        ui.optimizerSortMode = 'xpRatio';
        // Cost per 0.01 percentage point: rich 500, cheap 1K, dud 90K.
        expect(renderedOrder(SLOTS, 'xp')).toEqual(['rich', 'cheap', 'dud']);
    });

    test('G/0.01% Profit sorts the cheapest fixed percentage-point gain first', () => {
        ui.optimizerSortMode = 'profitRatio';
        // The same baselines make this order match Exp/Hr here; the metric is independently
        // derived from each row's Gold/hr gain in _computeSlotMetrics.
        expect(renderedOrder(SLOTS, 'gold')).toEqual(['rich', 'cheap', 'dud']);
    });

    test('a free net upgrade sorts before paid upgrades in either fixed percentage mode', () => {
        const slots = [slot('paid', 1000, 1000), slot('free', 100, 100)];
        engine.costs = { '/items/paid': 1_000_000, '/items/free': 0 };
        for (const mode of ['xpRatio', 'profitRatio']) {
            ui.optimizerSortMode = mode;
            expect(renderedOrder(slots, 'xp'), mode).toEqual(['free', 'paid']);
        }
    });

    test('Slot Order leaves the engine order untouched', () => {
        ui.optimizerSortMode = 'slot';
        expect(renderedOrder(SLOTS, 'xp')).toEqual(['cheap', 'rich', 'dud']);
    });

    test('an unpriceable slot sorts last under every cost-denominated mode', () => {
        engine.costs = { '/items/cheap': 1_000_000, '/items/rich': 5_000_000 }; // dud unpriced
        for (const mode of ['value', 'payback', 'cost', 'xpRatio', 'profitRatio']) {
            ui.optimizerSortMode = mode;
            expect(renderedOrder(SLOTS, 'xp').at(-1), mode).toBe('dud');
        }
    });

    test('changing the control re-renders in the new order', () => {
        const container = document.createElement('div');
        const result = {
            skill: 'Woodcutting',
            playerLevel: 50,
            goal: 'xp',
            xpBaseline: XP_BASELINE,
            goldBaseline: GOLD_BASELINE,
            slots: Object.fromEntries(SLOTS),
            goldHasMissingPrices: false,
        };
        ui._renderOptimizerResults(container, result, null, null);

        const select = container.querySelector('select');
        select.value = 'cost';
        select.dispatchEvent(new Event('change'));

        expect(container.querySelector('select').value).toBe('cost');
        expect(ui.optimizerSortMode).toBe('cost');
    });

    test('loadout baselines keep the selected actions and Alchemy item basis', () => {
        const selectedActionHrids = new Set(['/actions/alchemy/unrefine']);
        const alchemyContext = {
            actionType: 'unrefine',
            itemHrid: '/items/refined_plate',
            enhancementLevel: 10,
        };
        const loadout = new Map([['/item_locations/cheap', { itemHrid: '/items/current_tool', enhancementLevel: 7 }]]);
        const container = document.createElement('div');

        ui._renderOptimizerResults(
            container,
            {
                skill: 'Alchemy',
                playerLevel: 60,
                goal: 'xp',
                xpBaseline: XP_BASELINE,
                goldBaseline: GOLD_BASELINE,
                slots: Object.fromEntries([slot('cheap', 100, 100)]),
                goldHasMissingPrices: false,
                selectedActionHrids,
                alchemyContext,
                alchemyContextIsManual: true,
            },
            null,
            loadout
        );

        expect(engine.scoreCalls).toHaveLength(2);
        for (const call of engine.scoreCalls) {
            expect(call[4]).toBe(selectedActionHrids);
            expect(call[6]).toBe(alchemyContext);
        }
    });
});

describe('_computeSlotMetrics fixed percentage-point ratios', () => {
    test('derives each ratio from the matching baseline and gain', () => {
        engine.costs['/items/ratio'] = 2_000_000;
        const metrics = ui._computeSlotMetrics(slot('ratio', 600, 1200)[1], null, 1000, 1000);

        // Exp/hr: 60 percentage points / 0.01 = 6000 increments. Profit: 120 points = 12000.
        expect(metrics.xpRatio).toBeCloseTo(2_000_000 / 6000);
        expect(metrics.profitRatio).toBeCloseTo(2_000_000 / 12_000);
    });

    test('ranks a free improvement at zero gold per fixed percentage point', () => {
        engine.costs['/items/free'] = 0;
        const free = ui._computeSlotMetrics(slot('free', 100, 100)[1], null, 1000, 1000);
        expect(free.xpRatio).toBe(0);
        expect(free.profitRatio).toBe(0);
    });

    test('leaves a fixed percentage ratio absent when its baseline, gain, or price is unavailable', () => {
        engine.costs['/items/zero-baseline'] = 1_000_000;
        const zeroBaseline = ui._computeSlotMetrics(slot('zero-baseline', 100, 100)[1], null, 0, 0);
        expect(zeroBaseline.xpRatio).toBeNull();
        expect(zeroBaseline.profitRatio).toBeNull();

        const unpriced = ui._computeSlotMetrics(slot('unpriced', 100, 100)[1], null, 1000, 1000);
        expect(unpriced.xpRatio).toBeNull();
        expect(unpriced.profitRatio).toBeNull();
    });
});

describe('_sortValueFor', () => {
    const metrics = {
        entry: {},
        cost: 2_000_000,
        xpPct: 12,
        goldPct: 4,
        xpPerMillion: 500,
        paybackHours: 40,
        xpRatio: 1200,
        profitRatio: 3600,
    };

    test('a slot with nothing actionable sorts last in every mode', () => {
        const nothing = { entry: null, cost: null, xpPct: 0, goldPct: 0, xpPerMillion: null, paybackHours: null };
        for (const mode of ['value', 'payback', 'cost', 'xpGain', 'goldGain', 'xpRatio', 'profitRatio']) {
            expect(ui._sortValueFor(nothing, 'xp', mode), mode).toBe(Infinity);
        }
    });

    test('percentage modes sort descending, so their key is negated', () => {
        expect(ui._sortValueFor(metrics, 'xp', 'xpGain')).toBe(-12);
        expect(ui._sortValueFor(metrics, 'xp', 'goldGain')).toBe(-4);
    });

    test('Best Value follows the goal: XP-per-gold for xp, payback for gold', () => {
        expect(ui._sortValueFor(metrics, 'xp', 'value')).toBe(-500);
        expect(ui._sortValueFor(metrics, 'gold', 'value')).toBe(40);
    });

    test('fixed percentage-point ratio modes sort ascending and leave absent ratios last', () => {
        expect(ui._sortValueFor(metrics, 'xp', 'xpRatio')).toBe(1200);
        expect(ui._sortValueFor(metrics, 'gold', 'profitRatio')).toBe(3600);
        expect(ui._sortValueFor({ ...metrics, xpRatio: null }, 'xp', 'xpRatio')).toBe(Infinity);
        expect(ui._sortValueFor({ ...metrics, profitRatio: null }, 'gold', 'profitRatio')).toBe(Infinity);
    });

    test('a missing ratio sorts last rather than reading as the best possible score', () => {
        const unpriced = { ...metrics, cost: null, xpPerMillion: null, paybackHours: null };
        expect(ui._sortValueFor(unpriced, 'xp', 'value')).toBe(Infinity);
        expect(ui._sortValueFor(unpriced, 'gold', 'value')).toBe(Infinity);
        expect(ui._sortValueFor(unpriced, 'xp', 'cost')).toBe(Infinity);
        expect(ui._sortValueFor(unpriced, 'xp', 'payback')).toBe(Infinity);
    });
});
