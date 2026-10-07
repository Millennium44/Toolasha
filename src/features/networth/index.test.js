/**
 * The networth coordinator's recalculations overlap — cooldown-delayed item
 * updates, the price-update debounce and manual refreshes all call
 * recalculate(), and each run yields to the browser throughout. Completion
 * order does not follow start order: the worker-failure fallback revalues a
 * run's whole worker group sequentially, so an older run can finish after a
 * newer one. These tests pin that a superseded run's result is discarded
 * rather than overwriting fresher prices in currentData and the displays.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const calculatorMock = vi.hoisted(() => ({
    calculateNetworth: vi.fn(),
    networthUnitValue: vi.fn(() => 0),
}));

const displayMock = vi.hoisted(() => ({
    header: { update: vi.fn(), setNetworthFeature: vi.fn(), initialize: vi.fn(), disable: vi.fn() },
    inventory: { update: vi.fn(), setNetworthFeature: vi.fn(), initialize: vi.fn(), disable: vi.fn() },
}));

vi.mock('./networth-calculator.js', () => calculatorMock);
vi.mock('./networth-display.js', () => ({
    networthHeaderDisplay: displayMock.header,
    networthInventoryDisplay: displayMock.inventory,
}));
const popupMock = vi.hoisted(() => ({ refresh: vi.fn(), close: vi.fn() }));
vi.mock('./networth-exclusion-popup.js', () => ({ default: popupMock }));
const configMock = vi.hoisted(() => ({
    isFeatureEnabled: () => true,
    getSetting: () => false,
    getSettingValue: () => 'ask',
    onSettingChange: vi.fn(),
    offSettingChange: vi.fn(),
}));

vi.mock('../../core/config.js', () => ({ default: configMock }));
vi.mock('../../core/connection-state.js', () => ({
    default: { isConnected: () => true },
}));
vi.mock('../../utils/performance-monitor.js', () => ({
    default: { enabled: false, span: (_g, _n, fn) => fn(), record: vi.fn() },
}));
vi.mock('../../utils/background-work.js', () => ({ runInBackground: vi.fn() }));
const dataManagerMock = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
vi.mock('../../core/data-manager.js', () => ({
    default: dataManagerMock,
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('./networth-cache.js', () => ({ default: { clear: vi.fn(), checkAndInvalidate: vi.fn() } }));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: vi.fn() }));
vi.mock('./networth-history.js', () => ({ default: { initialize: vi.fn(), disable: vi.fn() } }));
vi.mock('./networth-history-chart.js', () => ({
    default: { setNetworthFeature: vi.fn(), toggleModal: vi.fn(), closeModal: vi.fn() },
}));
vi.mock('./production-income-recorder.js', () => ({
    default: { initialize: vi.fn(), cleanup: vi.fn() },
    mergeProductionDays: (a) => a,
}));
vi.mock('./chest-opening-recorder.js', () => ({
    default: { initialize: vi.fn(), cleanup: vi.fn() },
    mergeChestOpeningDays: (a) => a,
}));
vi.mock('./combat-loot-recorder.js', () => ({
    default: { initialize: vi.fn(), cleanup: vi.fn() },
    mergeCombatLootDays: (a) => a,
}));
vi.mock('./item-flow-recorder.js', () => ({ default: { initialize: vi.fn(), cleanup: vi.fn() } }));
vi.mock('./gold-sources-panel.js', () => ({ default: { closeModal: vi.fn() } }));
vi.mock('./networth-exclusions.js', () => ({ initExclusions: vi.fn() }));
vi.mock('../../utils/networth-worker-manager.js', () => ({
    calculateItemValueBatch: vi.fn(),
    terminateItemValueWorkerPool: vi.fn(),
}));

import networthFeature from './index.js';

/** A deferred calculateNetworth result the test resolves by hand. */
function deferred(totalNetworth) {
    let resolve;
    const promise = new Promise((res) => {
        resolve = () => res({ totalNetworth, coins: 0 });
    });
    return { promise, resolve };
}

beforeEach(() => {
    calculatorMock.calculateNetworth.mockReset();
    displayMock.header.update.mockClear();
    displayMock.inventory.update.mockClear();
    popupMock.refresh.mockClear();
    networthFeature.currentData = null;
    networthFeature.isActive = false;
});

describe('a calculation that had nothing to price with', () => {
    const unavailable = { unavailable: true, totalNetworth: 0, coins: 0 };

    test('leaves the last good figures published and on screen', async () => {
        calculatorMock.calculateNetworth.mockResolvedValueOnce({ totalNetworth: 5_000_000, coins: 10 });
        await networthFeature.recalculate();
        displayMock.header.update.mockClear();
        displayMock.inventory.update.mockClear();
        popupMock.refresh.mockClear();

        calculatorMock.calculateNetworth.mockResolvedValueOnce(unavailable);
        await networthFeature.recalculate();

        expect(networthFeature.currentData.totalNetworth).toBe(5_000_000);
        expect(displayMock.header.update).not.toHaveBeenCalled();
        expect(displayMock.inventory.update).not.toHaveBeenCalled();
        expect(popupMock.refresh).not.toHaveBeenCalled();
    });

    test('publishes nothing when there was no earlier figure either', async () => {
        calculatorMock.calculateNetworth.mockResolvedValueOnce(unavailable);
        await networthFeature.recalculate();

        expect(networthFeature.currentData).toBeNull();
        expect(displayMock.header.update).not.toHaveBeenCalled();
    });
});

describe('overlapping recalculations', () => {
    test('a superseded run does not overwrite a newer result', async () => {
        const older = deferred(111); // started first, finishes last
        const newer = deferred(222);
        calculatorMock.calculateNetworth.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

        const olderRun = networthFeature.recalculate();
        const newerRun = networthFeature.recalculate();

        newer.resolve();
        await newerRun;
        expect(networthFeature.currentData.totalNetworth).toBe(222);

        older.resolve();
        await olderRun;

        // The stale run's answer must not land anywhere the UI reads
        expect(networthFeature.currentData.totalNetworth).toBe(222);
        const lastHeaderUpdate = displayMock.header.update.mock.calls.at(-1);
        expect(lastHeaderUpdate[0].totalNetworth).toBe(222);
        expect(displayMock.header.update).toHaveBeenCalledTimes(1);
    });

    test('runs that finish in start order both land', async () => {
        const first = deferred(111);
        const second = deferred(222);
        calculatorMock.calculateNetworth.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

        const firstRun = networthFeature.recalculate();
        first.resolve();
        await firstRun;
        expect(networthFeature.currentData.totalNetworth).toBe(111);

        const secondRun = networthFeature.recalculate();
        second.resolve();
        await secondRun;
        expect(networthFeature.currentData.totalNetworth).toBe(222);
        expect(displayMock.header.update).toHaveBeenCalledTimes(2);
    });
});

describe('a character switch mid-recalculation', () => {
    test('a run in flight when the feature is disabled does not refill currentData', async () => {
        const inFlight = deferred(111);
        calculatorMock.calculateNetworth.mockReturnValueOnce(inFlight.promise);

        const run = networthFeature.recalculate();
        networthFeature.disable();

        inFlight.resolve();
        await run;

        // The figure belongs to the character that has just been left
        expect(networthFeature.currentData).toBeNull();
        expect(displayMock.header.update).not.toHaveBeenCalled();
    });
});

describe('the game value map refreshing', () => {
    const handlerFor = (event) => dataManagerMock.on.mock.calls.filter(([name]) => name === event).at(-1)?.[1];

    test('re-prices in both value-source modes and is removed on disable', async () => {
        vi.useFakeTimers();
        const original = configMock.getSettingValue;
        try {
            configMock.getSettingValue = () => 'officialValue';
            networthFeature.isActive = true;
            calculatorMock.calculateNetworth.mockReset();
            calculatorMock.calculateNetworth.mockResolvedValue({ totalNetworth: 1, coins: 0 });
            dataManagerMock.on.mockClear();
            networthFeature.setupEventListeners();

            const handler = handlerFor('market_item_values_updated');
            expect(handler).toBeTypeOf('function');
            handler();
            await vi.advanceTimersByTimeAsync(1100);
            expect(calculatorMock.calculateNetworth).toHaveBeenCalledTimes(1);

            // Order-book mode re-prices too: reconcileBook fills empty books and clamps stale quotes from the map
            configMock.getSettingValue = () => 'orderBook';
            handler();
            await vi.advanceTimersByTimeAsync(1100);
            expect(calculatorMock.calculateNetworth).toHaveBeenCalledTimes(2);

            dataManagerMock.off.mockClear();
            networthFeature.disable();
            expect(dataManagerMock.off).toHaveBeenCalledWith('market_item_values_updated', handler);
        } finally {
            configMock.getSettingValue = original;
            networthFeature.isActive = false;
            vi.useRealTimers();
        }
    });
});

describe('pricing settings', () => {
    test('settings that affect valuation invoke recalculation and publish the new total', async () => {
        networthFeature.isActive = true;
        networthFeature.currentData = { totalNetworth: 10, coins: 0 };
        configMock.onSettingChange.mockClear();
        networthFeature.setupEventListeners();

        const keys = configMock.onSettingChange.mock.calls.map(([key]) => key);
        expect(keys).toContain('networth_pricingMode');
        expect(keys).toContain('networth_valueSource');
        const handlerFor = (key) =>
            configMock.onSettingChange.mock.calls.find(([registeredKey]) => registeredKey === key)?.[1];
        const keysThatReprice = [
            'networth_pricingMode',
            'networth_valueSource',
            'networth_highEnhancementUseCost',
            'networth_highEnhancementMinLevel',
            'networth_includeCowbells',
            'networth_includeTaskTokens',
            'networth_abilityBooksAsInventory',
        ];
        for (const [index, key] of keysThatReprice.entries()) {
            calculatorMock.calculateNetworth.mockResolvedValueOnce({ totalNetworth: 20 + index, coins: 0 });
            handlerFor(key)();
            await vi.waitFor(() => expect(networthFeature.currentData.totalNetworth).toBe(20 + index));
        }
        expect(calculatorMock.calculateNetworth).toHaveBeenCalledTimes(keysThatReprice.length);
        networthFeature.isActive = false;
    });

    test('the Iron Cow valuation re-prices net worth with the same handler as the pricing mode', () => {
        configMock.onSettingChange.mockClear();
        networthFeature.setupEventListeners();

        const calls = configMock.onSettingChange.mock.calls;
        const handlerFor = (key) => calls.find(([k]) => k === key)?.[1];
        // Switching Market / Vendor / Best on an Iron Cow character used to leave
        // net worth on the old figure until an unrelated item or price update
        expect(handlerFor('profitCalc_ironCowValuation')).toBeTypeOf('function');
        expect(handlerFor('profitCalc_ironCowValuation')).toBe(handlerFor('networth_pricingMode'));
    });

    test('Iron Cow valuation setting invokes recalculation', async () => {
        networthFeature.isActive = true;
        networthFeature.currentData = { totalNetworth: 10, coins: 0 };
        configMock.onSettingChange.mockClear();
        networthFeature.setupEventListeners();

        calculatorMock.calculateNetworth.mockResolvedValueOnce({ totalNetworth: 25, coins: 0 });
        const handler = configMock.onSettingChange.mock.calls.find(
            ([key]) => key === 'profitCalc_ironCowValuation'
        )?.[1];
        handler();
        await vi.waitFor(() => expect(networthFeature.currentData.totalNetworth).toBe(25));
        expect(calculatorMock.calculateNetworth).toHaveBeenCalledTimes(1);
        networthFeature.isActive = false;
    });
});
