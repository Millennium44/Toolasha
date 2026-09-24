/**
 * The "Cash" line on a queued Coinify row and in the action bar.
 *
 * Profit nets a coinify row against the value of what went in — on an Iron Cow character that
 * value is the essence's IC valuation, so Profit reads as a small catalyst/tea uplift even though
 * the coinify step itself pays out far more in coins. Cash is that payout on its own: attempts
 * times the row's own coins-per-success figure (`incomePerAttempt` off
 * `calculateCoinifyProfit`), which already accounts for the row's catalyst and tea. Coins are
 * never taxed, so Cash needs no market-tax treatment the way a sold-item revenue figure would.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

vi.mock('../../core/tooltip-observer.js', () => ({
    default: { register: () => () => {}, onTooltip: () => () => {} },
}));

const game = vi.hoisted(() => ({
    /** What `calculateCoinifyProfit` answers, keyed by the catalyst choice it was called with */
    coinifyByChoice: {},
    /** Cowbells setting + the raw bag-of-10 ask price the Cowbells line reads */
    cowbellsSetting: false,
    bagAskPrice: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => [],
        getActionDetails: (hrid) =>
            hrid === '/actions/alchemy/coinify'
                ? { hrid, name: 'Coinify', type: '/action_types/alchemy', inputItems: [] }
                : null,
        getItemDetails: () => null,
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: {} }),
        getActionDrinkSlots: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
        getSkills: () => [],
        getEquipment: () => [],
        getCurrentCharacterId: () => 'char1',
        get characterData() {
            return { characterLoadoutMap: {} };
        },
        on: () => () => {},
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (key, fallback) => {
            if (key === 'actionQueue_coinifyCashAsCowbells') return game.cowbellsSetting;
            if (key === 'color_profit') return '#4ade80';
            if (key === 'color_loss') return '#f87171';
            return fallback;
        },
        COLOR_TOOLTIP_INFO: '#abc',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => false, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({
    default: { calculate: async () => null, calculateProfit: async () => null },
}));
vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: {
        calculateCoinifyProfit: (
            itemHrid,
            enhancementLevel,
            useLiveSetup,
            teaBonusOverride,
            actionContext,
            catalystChoice
        ) => game.coinifyByChoice[catalystChoice ?? 'none'] ?? null,
        calculateDecomposeProfit: () => null,
        calculateTransmuteProfit: () => null,
    },
}));
vi.mock('../../utils/liquidity-cap.js', () => ({
    capProfitData: async (profitData) => profitData,
    liquidityMarkerHtml: () => '',
}));
vi.mock('../../utils/calibration-badge.js', () => ({
    calibrationBadgeFor: () => null,
    badgeHtml: () => '',
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: () => null,
    getRawMarketAskPrice: (itemHrid) => (itemHrid === '/items/bag_of_10_cowbells' ? game.bagAskPrice : null),
}));

const actionTimeDisplay = (await import('./action-time-display.js')).default;

const COINIFY = '/actions/alchemy/coinify';
const FORAGING_ESSENCE = '/items/foraging_essence';

/** A queued Coinify action, as the game shapes it: item and catalyst ride in the two hashes. */
function coinifyAction({ id = 1, itemHrid = FORAGING_ESSENCE, count, catalystHrid = '' } = {}) {
    return {
        id,
        actionHrid: COINIFY,
        primaryItemHash: `161296::/item_locations/inventory::${itemHrid}::0`,
        secondaryItemHash: catalystHrid ? `161296::/item_locations/inventory::${catalystHrid}::0` : '',
        count,
        divIndex: 0,
    };
}

/** A profitDiv the way injectQueueTimes creates one, tagged for a given divIndex. */
function profitDivFor(divIndex) {
    const div = document.createElement('div');
    div.className = 'mwi-queue-action-profit';
    div.dataset.divIndex = String(divIndex);
    document.body.appendChild(div);
    return div;
}

beforeEach(() => {
    document.body.innerHTML = '';
    game.coinifyByChoice = {};
    game.cowbellsSetting = false;
    game.bagAskPrice = null;
});

describe('queued Coinify row: Cash line', () => {
    test('a counted row shows Cash as attempts × coins-per-success, above and beyond Profit', async () => {
        profitDivFor(0);
        // 10 essences per attempt at 250 coins each (sellPrice 50 × 5), 91.7% success (Prime),
        // netted against a small catalyst/tea cost for Profit — Cash ignores that net.
        // actionsPerHour == count makes profitPerAction × count == profitPerHour exactly, so
        // the Profit total below is easy to check by eye.
        game.coinifyByChoice.none = {
            profitPerHour: 8_020_000,
            actionsPerHour: 18200,
            incomePerAttempt: 10 * 250 * 0.917,
        };
        const action = coinifyAction({ count: 18200 });

        await actionTimeDisplay.calculateAndDisplayTotalProfit(
            document.createElement('div'),
            [action],
            'Total time: [2h]',
            document.createElement('div')
        );

        const text = document.querySelector('.mwi-queue-action-profit').innerHTML;
        expect(text).toContain('Profit: <span style="color: #4ade80;">+8.02M</span>');
        // 18,200 × 10 × 250 × 0.917 = 41,723,500
        expect(text).toMatch(/Cash:.*\+41\.72M/s);
        expect(text).not.toMatch(/NaN|undefined/);
    });

    test('an ∞ input-limited row uses the row-s own expected-attempts estimate, not a per-hour rate', async () => {
        profitDivFor(0);
        game.coinifyByChoice.none = {
            profitPerHour: 500,
            actionsPerHour: 500,
            incomePerAttempt: 175,
        };
        // The queue pass hands this helper whatever `count` the material-limit estimate produced
        // for an unbounded ∞ row — 4,000 attempts here, not an actionsPerHour rate.
        const action = coinifyAction({ count: 4000 });

        await actionTimeDisplay.calculateAndDisplayTotalProfit(
            document.createElement('div'),
            [action],
            'Total time: [∞]',
            document.createElement('div')
        );

        const text = document.querySelector('.mwi-queue-action-profit').innerHTML;
        expect(text).toMatch(/Cash:.*\+700\.00K/s);
    });

    test('a Prime Catalyst row is priced with the catalyst the calculator was asked for', async () => {
        profitDivFor(0);
        game.coinifyByChoice.prime = {
            profitPerHour: 100,
            actionsPerHour: 1000,
            incomePerAttempt: 300,
        };
        const action = coinifyAction({ count: 100, catalystHrid: '/items/prime_catalyst' });

        await actionTimeDisplay.calculateAndDisplayTotalProfit(
            document.createElement('div'),
            [action],
            'Total time: [1h]',
            document.createElement('div')
        );

        const text = document.querySelector('.mwi-queue-action-profit').innerHTML;
        // 100 attempts × 300 coins = 30,000
        expect(text).toMatch(/Cash:.*\+30\.00K/s);
    });

    test('on an Iron Cow character, Cash is far larger than Profit for the same row', async () => {
        profitDivFor(0);
        // Profit is only the catalyst/tea uplift against the IC-valued essence input; Cash is
        // the coinify step's own payout, which is what motivates the loop in the first place.
        game.coinifyByChoice.none = {
            profitPerHour: 8_020_000,
            actionsPerHour: 18200,
            incomePerAttempt: 10 * 250 * 0.917,
        };
        const action = coinifyAction({ count: 18200 });

        await actionTimeDisplay.calculateAndDisplayTotalProfit(
            document.createElement('div'),
            [action],
            'Total time: [1h]',
            document.createElement('div')
        );

        const text = document.querySelector('.mwi-queue-action-profit').innerHTML;
        expect(text).toContain('Profit: <span style="color: #4ade80;">+8.02M</span>');
        expect(text).toMatch(/Cash:.*\+41\.72M/s);
    });

    test('no market data for the coinified item omits the Cash line entirely, not a NaN one', async () => {
        profitDivFor(0);
        game.coinifyByChoice.none = null;
        const action = coinifyAction({ count: 100 });

        await actionTimeDisplay.calculateAndDisplayTotalProfit(
            document.createElement('div'),
            [action],
            'Total time: [1h]',
            document.createElement('div')
        );

        const div = document.querySelector('.mwi-queue-action-profit');
        expect(div.innerHTML).toBe('');
    });
});

describe('queued Coinify row: Cowbells line', () => {
    beforeEach(() => {
        game.coinifyByChoice.none = {
            profitPerHour: 100,
            actionsPerHour: 1000,
            incomePerAttempt: 2500,
        };
    });

    test('hidden by default', async () => {
        game.bagAskPrice = 10_000;
        profitDivFor(0);
        const action = coinifyAction({ count: 100 });

        await actionTimeDisplay.calculateAndDisplayTotalProfit(
            document.createElement('div'),
            [action],
            'Total time: [1h]',
            document.createElement('div')
        );

        expect(document.querySelector('.mwi-queue-action-profit').innerHTML).not.toContain('Cowbells');
    });

    test('shown when the setting is enabled and the bag has a price', async () => {
        game.cowbellsSetting = true;
        game.bagAskPrice = 10_000; // 1,000 gold per Cowbell
        profitDivFor(0);
        const action = coinifyAction({ count: 100 });

        await actionTimeDisplay.calculateAndDisplayTotalProfit(
            document.createElement('div'),
            [action],
            'Total time: [1h]',
            document.createElement('div')
        );

        const text = document.querySelector('.mwi-queue-action-profit').innerHTML;
        // Cash = 100 × 2500 = 250,000 coins ÷ 1,000 gold/Cowbell = 250 Cowbells
        expect(text).toMatch(/≈ 250 Cowbells/);
    });

    test('omitted (not a zero) when the bag has no market price', async () => {
        game.cowbellsSetting = true;
        game.bagAskPrice = null;
        profitDivFor(0);
        const action = coinifyAction({ count: 100 });

        await actionTimeDisplay.calculateAndDisplayTotalProfit(
            document.createElement('div'),
            [action],
            'Total time: [1h]',
            document.createElement('div')
        );

        const text = document.querySelector('.mwi-queue-action-profit').innerHTML;
        expect(text).toContain('Cash:');
        expect(text).not.toContain('Cowbells');
        expect(text).not.toMatch(/NaN|undefined/);
    });
});

describe('coinifyCashFor helper', () => {
    test('returns null without a numeric incomePerAttempt or attempts figure', () => {
        expect(actionTimeDisplay.coinifyCashFor(null, 100)).toBeNull();
        expect(actionTimeDisplay.coinifyCashFor({ incomePerAttempt: 'x' }, 100)).toBeNull();
        expect(actionTimeDisplay.coinifyCashFor({ incomePerAttempt: 10 }, Infinity)).toBeNull();
        expect(actionTimeDisplay.coinifyCashFor({ incomePerAttempt: 10 }, NaN)).toBeNull();
    });

    test('multiplies coins-per-attempt by attempts', () => {
        expect(actionTimeDisplay.coinifyCashFor({ incomePerAttempt: 250 }, 40)).toBe(10_000);
    });
});
