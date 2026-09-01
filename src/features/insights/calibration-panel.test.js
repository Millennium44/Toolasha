/** @vitest-environment happy-dom */

/**
 * The calibration panel, built rather than reasoned about.
 *
 * `createPanel` swallows a draw failure into "could not be drawn" so one bad
 * section does not blank the rest, which means a renamed helper or a field that
 * stopped existing shows up as a quiet grey line and nothing else. Asserting
 * that string is absent is the only check that catches it — no arithmetic test
 * can, because the arithmetic would still be right.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => ({
    records: [],
    enhancing: [],
    alchemy: { transmute: [], decompose: [], coinify: [] },
}));

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: (definition) => store.rows.push(definition) }));
vi.mock('./prediction-calibration.js', () => ({
    predictionCalibration: {
        getCachedRecords: () => store.records,
        getRecords: async () => store.records,
    },
}));
vi.mock('./enhancement-calibration.js', () => ({
    enhancementCalibration: {
        getCachedRecords: () => store.enhancing,
        getRecords: async () => store.enhancing,
    },
}));
// The alchemy sessions come from the trackers themselves; mocked at the tracker
// rather than at the store so the panel's own async read is what is exercised
vi.mock('../alchemy/transmute-history-tracker.js', () => ({
    transmuteHistoryTracker: { loadSessions: async () => store.alchemy.transmute },
}));
vi.mock('../alchemy/decompose-history-tracker.js', () => ({
    decomposeHistoryTracker: { loadSessions: async () => store.alchemy.decompose },
}));
vi.mock('../alchemy/coinify-history-tracker.js', () => ({
    coinifyHistoryTracker: { loadSessions: async () => store.alchemy.coinify },
}));

store.rows = [];

const { calibrationPanel, registerCalibrationRow, forgetAlchemySessions } = await import('./calibration-panel.js');

const HOUR = 3600_000;
const now = Date.parse('2026-08-04T12:00:00Z');

/**
 * A recorded pair.
 * @param {string} actionType - Skill
 * @param {number} predicted - Predicted per hour
 * @param {number} actual - Actual per hour
 * @param {number} hoursAgo - When it finished
 * @returns {Object}
 */
const pair = (actionType, predicted, actual, hoursAgo = 1) => ({
    id: `${actionType}-${hoursAgo}-${actual}`,
    actionType,
    actionCount: 120,
    predicted,
    actual,
    t: now - hoursAgo * HOUR,
});

/** What the open panel says. */
const text = () => calibrationPanel.panel?.textContent || '';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    store.records = [];
    store.enhancing = [];
    store.rows = [];
    store.alchemy = { transmute: [], decompose: [], coinify: [] };
    // The panel caches the trackers' sessions at module level for fifteen
    // seconds, and the clock is pinned to the same instant in every test — so
    // without this the previous test's alchemy cards are still what the next
    // test's panel draws
    forgetAlchemySessions();
});

afterEach(() => {
    calibrationPanel.hide({ remember: false });
    vi.useRealTimers();
});

describe('the panel', () => {
    test('says so plainly when no run has been measured', () => {
        calibrationPanel.show({ remember: false });
        expect(text()).toContain('No finished runs measured yet');
        expect(text()).not.toContain('could not be drawn');
    });

    test('draws every section when there are pairs', () => {
        store.records = [
            ...Array.from({ length: 6 }, (_, i) => pair('milking', 1_000_000, 500_000, i + 1)),
            ...Array.from({ length: 3 }, (_, i) => pair('cooking', 1_000_000, 990_000, 26 + i)),
        ];

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Overall (9 runs)');
        expect(text()).toContain('Milking');
        expect(text()).toContain('Cooking');
        expect(text()).toContain('Recent runs');
        // Six runs agreeing that the forecast is double what the run paid
        expect(text()).toContain('Persistent gap');
        expect(text()).toContain('-50.0%');
    });

    test('waits rather than claiming there is nothing, while the read is in flight', () => {
        store.records = null;
        calibrationPanel.show({ remember: false });
        expect(text()).toContain('Reading history');
    });

    test('draws combat as a group, carrying its provenance flags', () => {
        store.records = Array.from({ length: 3 }, (_, i) => ({
            ...pair('combat', 1_000_000, 800_000, i + 1),
            actionHrid: '/actions/combat/rat_cave',
            difficultyTier: 1,
            snapshotAgeMs: 2 * 24 * HOUR,
            fingerprintMatch: i !== 0,
        }));

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Combat');
        // The forecast's provenance sits with the figures, not behind them
        expect(text()).toContain('Forecast: all-zones sim');
        expect(text()).toContain('1 of 3 in different gear');
        // Recent runs name the zone and mark the mismatched pair
        expect(text()).toContain('Rat cave T1');
        expect(text()).toContain('⚠');
    });

    test('draws enhancement runs as percentiles, even with no rate pairs at all', () => {
        store.enhancing = [
            {
                id: 's1:8',
                t: now - HOUR,
                itemHrid: '/items/cheese_sword',
                itemName: 'Cheese Sword',
                targetLevel: 8,
                expectedAttempts: 41,
                observedAttempts: 63,
                tailProbability: 0.08,
            },
        ];

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Enhancing (1 runs)');
        expect(text()).toContain('Median outcome percentile');
        expect(text()).toContain('92%');
        expect(text()).toContain('Cheese Sword +8');
        // The percentile is the headline, never a bare predicted-vs-actual gap
        expect(text()).toContain('8% take ≥');
        expect(text()).not.toContain('No finished runs measured yet');
    });
});

describe('the per-action fold', () => {
    /**
     * A run of one named action.
     * @param {string} actionHrid - Which action
     * @param {number} index - Makes the pair unique
     * @param {number} actual - What it paid
     * @returns {Object}
     */
    const run = (actionHrid, index, actual) => ({
        ...pair('milking', 1_000_000, actual, index + 1),
        id: `${actionHrid}-${index}`,
        actionHrid,
    });

    /**
     * The clickable heading, whichever way it is pointing.
     * @returns {HTMLElement|undefined}
     */
    const heading = () =>
        [...(calibrationPanel.panel?.querySelectorAll('div') || [])].find((el) =>
            /^[▸▾] Per action/.test(el.textContent)
        );

    test('lists each action only once opened, and gates thin actions on their own count', () => {
        store.records = [
            ...Array.from({ length: 6 }, (_, i) => run('/actions/milking/cow', i, 500_000)),
            ...Array.from({ length: 3 }, (_, i) => run('/actions/milking/sheep', 10 + i, 100_000)),
        ];

        calibrationPanel.show({ remember: false });
        expect(text()).not.toContain('could not be drawn');

        // Folded away by default — the breakdown is there, not in the way
        expect(text()).toContain('▸ Per action (2)');
        expect(text()).toContain('1 too thin');
        expect(text()).not.toContain('Cow');

        heading().click();

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('▾ Per action (2)');
        expect(text()).toContain('Cow (6)');
        expect(text()).toContain('-50.0%');
        // Three runs of sheep inside a group of nine is still three runs
        // The refusal stands where the figure would have been, not beside it
        expect(text()).toContain('Sheep (3)too few to call');

        heading().click();
        expect(text()).toContain('▸ Per action (2)');
        expect(text()).not.toContain('Cow (6)');
    });
});

describe('the per-version fold', () => {
    /**
     * A pair stamped with a script version, priced at both ask and bid.
     * @param {string|null} version - The `v` stamp
     * @param {number} index - Makes the pair unique
     * @param {number} actual - Ask-priced result
     * @param {number} actualBid - Bid-priced result
     * @returns {Object}
     */
    const stamped = (version, index, actual, actualBid) => ({
        ...pair('milking', 1_000_000, actual, index + 1),
        id: `${version}-${index}`,
        actionHrid: '/actions/milking/cow',
        v: version,
        actualBid,
    });

    /**
     * The clickable heading, whichever way it is pointing.
     * @returns {HTMLElement|undefined}
     */
    const heading = () =>
        [...(calibrationPanel.panel?.querySelectorAll('div') || [])].find((el) =>
            /^[▸▾] Per script version/.test(el.textContent)
        );

    test('shows the cohort medians oldest first, with the pairs each still holds', () => {
        store.records = [
            ...Array.from({ length: 6 }, (_, i) => stamped('3.32', i, 1_000_000, 980_000)),
            ...Array.from({ length: 6 }, (_, i) => stamped('3.33', 10 + i, 700_000, 690_000)),
        ];

        calibrationPanel.show({ remember: false });
        expect(text()).toContain('▸ Per script version (2)');
        expect(text()).not.toContain('3.32 (6)');

        heading().click();
        expect(text()).not.toContain('could not be drawn');
        // Oldest first, and each figure carries the count still in the ledger
        expect(text().indexOf('3.32 (6)')).toBeLessThan(text().indexOf('3.33 (6)'));
        expect(text()).toContain('-30.0%');
        // Both series fell together, so the market moved — and it is stated as
        // happening AT the boundary, never because of the release
        expect(text()).toContain('the market moved');
        expect(text()).toContain('at 3.32 → 3.33');
        expect(text()).not.toMatch(/because of 3\.33/);
    });

    test('stays out of the way when there is only one cohort to show', () => {
        store.records = Array.from({ length: 6 }, (_, i) => stamped('3.33', i, 900_000, 890_000));
        calibrationPanel.show({ remember: false });
        expect(text()).not.toContain('Per script version');
    });
});

describe('the ask/bid spread line', () => {
    test('names what share of the forecast needs a buyer to turn up', () => {
        store.records = Array.from({ length: 6 }, (_, i) => ({
            ...pair('milking', 1_000_000, 1_000_000, i + 1),
            id: `bid-${i}`,
            actionHrid: '/actions/milking/cow',
            actualBid: 700_000,
        }));

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Ask vs bid');
        expect(text()).toContain('30% of this forecast depends on selling into the ask');
    });

    test('refuses rather than reading a missing bid figure as no spread', () => {
        store.records = Array.from({ length: 6 }, (_, i) => ({
            ...pair('milking', 1_000_000, 1_000_000, i + 1),
            id: `nobid-${i}`,
            actionHrid: '/actions/milking/cow',
        }));

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Too few bid-priced runs to call');
        expect(text()).not.toContain('0% of this forecast');
    });
});

describe('the alchemy success cards', () => {
    /**
     * A tracker session with a stamped prediction.
     * @param {Object} fields - `{id, item, rate, attempts, successes, catalyst}`
     * @returns {Object}
     */
    const alchemySession = ({
        id = 'a1',
        item = '/items/gem',
        rate = 0.6,
        attempts = 1000,
        successes = 600,
        catalyst = null,
    } = {}) => ({
        id,
        startTime: now - HOUR,
        inputItemHrid: item,
        predictedRate: rate,
        predictedAt: now - HOUR,
        predictedCatalystHrid: catalyst,
        totalAttempts: attempts,
        totalSuccesses: successes,
    });

    /**
     * Open the panel with the alchemy read allowed to land.
     *
     * The sessions are read asynchronously and cached for a while, so the clock
     * is pushed past that window to force a fresh read, and the microtask queue
     * is flushed before the body is built again.
     * @returns {Promise<void>}
     */
    let tick = 0;
    const openWithAlchemy = async () => {
        // Each test moves the clock further forward than the last: the cache is
        // module state that outlives a test, and re-using the same instant would
        // leave the previous test's sessions on screen
        vi.setSystemTime(now + ++tick * 60_000);
        calibrationPanel.show({ remember: false });
        await vi.advanceTimersByTimeAsync(1);
        calibrationPanel.render();
    };

    test('judges each tracker separately, against the rate stamped on its sessions', async () => {
        store.alchemy.transmute = [alchemySession({ id: 't', rate: 0.6, attempts: 1000, successes: 400 })];
        store.alchemy.coinify = [alchemySession({ id: 'c', rate: 0.7, attempts: 1000, successes: 700 })];

        await openWithAlchemy();

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Transmute success (1000 attempts)');
        expect(text()).toContain('Coinify success (1000 attempts)');
        // Three separate models, so the bad transmute does not condemn coinify
        expect(text()).toContain('Sim too high');
        expect(text()).toContain('Consistent');
        expect(text()).toContain('95% interval');
        // And a kind with no sessions gets no card at all
        expect(text()).not.toContain('Decompose success');
    });

    test('excludes unstamped sessions and says how many are sitting out', async () => {
        store.alchemy.decompose = [
            alchemySession({ id: 'd1', rate: 0.6, attempts: 400, successes: 240 }),
            // Recorded before stamping: 5000 failures that must not vote
            { ...alchemySession({ id: 'd2', attempts: 5000, successes: 0 }), predictedRate: null },
        ];

        await openWithAlchemy();

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Decompose success (400 attempts)');
        expect(text()).toContain('1 unstamped session');
        expect(text()).toContain('Consistent');
    });

    test('breaks a kind down by item and catalyst once opened', async () => {
        store.alchemy.transmute = [
            alchemySession({ id: 'a', item: '/items/gem', rate: 0.5, attempts: 1000, successes: 500 }),
            alchemySession({
                id: 'b',
                item: '/items/gem',
                catalyst: '/items/prime_catalyst',
                rate: 0.75,
                attempts: 1000,
                successes: 500,
            }),
            alchemySession({ id: 'c', item: '/items/milk', rate: 0.5, attempts: 10, successes: 5 }),
        ];

        await openWithAlchemy();
        expect(text()).toContain('▸ Per item and catalyst (3)');

        const heading = [...calibrationPanel.panel.querySelectorAll('div')].find((el) =>
            /^▸ Per item and catalyst/.test(el.textContent)
        );
        heading.click();

        expect(text()).not.toContain('could not be drawn');
        // The same item run with a catalyst was predicted a different rate, and
        // is judged as its own combination rather than pooled with the plain one
        expect(text()).toContain('Gem · Prime catalyst (1000)');
        expect(text()).toContain('Gem (1000)');
        expect(text()).toContain('Milk (10)too few attempts to call');

        heading.click();
    });

    test('says nothing has been measured when the sessions are all unstamped', async () => {
        store.alchemy.coinify = [{ ...alchemySession({ attempts: 900, successes: 300 }), predictedRate: null }];

        await openWithAlchemy();

        expect(text()).not.toContain('could not be drawn');
        // The card is still drawn — the sessions exist — but it issues no verdict
        expect(text()).toContain('Coinify success (0 attempts)');
        expect(text()).toContain('Too few attempts to call');
        expect(text()).toContain('1 unstamped session');
        expect(text()).not.toContain('95% interval');
    });

    test("a character switch takes the departing character's sessions with it", async () => {
        store.alchemy.coinify = [alchemySession({ id: 'c', rate: 0.7, attempts: 1000, successes: 700 })];
        await openWithAlchemy();
        expect(text()).toContain('Coinify success (1000 attempts)');

        // What the insights feature's cleanup() does on character_switching.
        // Without it the cards stayed up for the rest of ALCHEMY_REREAD_MS,
        // reading as the arriving character's alchemy record
        forgetAlchemySessions();
        store.alchemy.coinify = [];
        calibrationPanel.render();

        expect(text()).not.toContain('Coinify success (1000 attempts)');
    });
});

describe('the overlay tile', () => {
    test('is only put up when asked, and opens the panel', () => {
        expect(store.rows).toHaveLength(0);
        registerCalibrationRow();

        const [tile] = store.rows;
        expect(tile.key).toBe('predictionCalibration');
        expect(typeof tile.onOpen).toBe('function');

        store.records = Array.from({ length: 6 }, (_, i) => pair('milking', 1_000_000, 500_000, i + 1));
        const container = document.createElement('div');
        tile.render(container);

        expect(container.textContent).toContain('Milking');
        expect(container.textContent).toContain('-50.0%');
        expect(container.title).toContain('This gap has held');
    });

    test('draws nothing rather than zeroes when there is no history', () => {
        registerCalibrationRow();
        const container = document.createElement('div');
        store.records = [];
        store.rows[0].render(container);
        expect(container.textContent.trim()).toBe('');
    });
});

describe('the combat card’s verdicts', () => {
    /**
     * A combat pair, with the gear flag and both rates under the test's control.
     * @param {number} index - Makes the id unique
     * @param {Object} fields - `{goldDeviation, xpDeviation, fingerprintMatch}`
     * @returns {Object}
     */
    const combat = (index, { goldDeviation, xpDeviation = null, fingerprintMatch = true }) => ({
        ...pair('combat', 1_000_000, 1_000_000 * (1 + goldDeviation / 100), index + 1),
        id: `combat-${index}`,
        actionHrid: '/actions/combat/rat_cave',
        difficultyTier: 1,
        snapshotAgeMs: 2 * 24 * HOUR,
        fingerprintMatch,
        predictedXpPerHour: xpDeviation === null ? null : 500_000,
        actualXpPerHour: xpDeviation === null ? null : 500_000 * (1 + xpDeviation / 100),
    });

    test('XP landing while gold does not sends the reader to drops and prices', () => {
        store.records = Array.from({ length: 8 }, (_, i) => combat(i, { goldDeviation: -30, xpDeviation: -2 }));

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('XP deviation (median of 8)');
        expect(text()).toContain('XP pairs');
        expect(text()).toContain('8 of 8');
        expect(text()).toContain('the gap is drops or prices');
    });

    test('both rates off the same way indicts the fight model instead', () => {
        store.records = Array.from({ length: 8 }, (_, i) => combat(i, { goldDeviation: -30, xpDeviation: -27 }));

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('mis-models the fight itself');
    });

    test('pairs with no XP rate are counted aside, and too few is a refusal', () => {
        store.records = [
            ...Array.from({ length: 3 }, (_, i) => combat(i, { goldDeviation: -30, xpDeviation: -2 })),
            ...Array.from({ length: 5 }, (_, i) => combat(i + 3, { goldDeviation: -30 })),
        ];

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('5 without XP');
        expect(text()).toContain('Too few XP pairs to call');
    });

    test('the gear split is drawn beside the caveats, not instead of them', () => {
        store.records = [
            ...Array.from({ length: 7 }, (_, i) => combat(i, { goldDeviation: -2, fingerprintMatch: true })),
            ...Array.from({ length: 7 }, (_, i) => combat(i + 7, { goldDeviation: -31, fingerprintMatch: false })),
        ];

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        // The existing caveat lines survive
        expect(text()).toContain('Forecast: all-zones sim');
        expect(text()).toContain('7 of 14 in different gear');
        // And the split says what the pooled median could not
        expect(text()).toContain('matched -2.0% (7)');
        expect(text()).toContain('mismatched -31.0% (7)');
        expect(text()).toContain('the gear it never saw');
    });

    test('a thin cohort refuses rather than issuing a split verdict', () => {
        store.records = [
            ...Array.from({ length: 10 }, (_, i) => combat(i, { goldDeviation: -2, fingerprintMatch: true })),
            ...Array.from({ length: 2 }, (_, i) => combat(i + 10, { goldDeviation: -31, fingerprintMatch: false })),
        ];

        calibrationPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Too few per cohort to call');
        expect(text()).not.toContain('the gear it never saw');
    });
});
