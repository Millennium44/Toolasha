/**
 * What a queued fight is expected to make, on the row and in the panel's total.
 *
 * A combat row used to show a time and nothing else: the profit pass behind the other rows asks
 * the market calculators, and a fight has no recipe to ask about. The simulated reading that
 * times the row already carries a profit per hour, so the row can say both what the run is worth
 * and the rate it rests on — and must say neither when the reading could not give one, rather
 * than printing a zero that reads as "this fight earns nothing".
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

const game = vi.hoisted(() => ({
    currentActions: [],
    actionDetails: {},
    snapshot: null,
    loadoutMap: {},
    rates: {},
    valueMode: 'profit',
    showValue: true,
    characterId: 'char1',
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.currentActions,
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        getItemDetails: () => null,
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: {} }),
        getActionDrinkSlots: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
        getSkills: () => [],
        getEquipment: () => [],
        getCurrentCharacterId: () => game.characterId,
        get characterData() {
            return { characterLoadoutMap: game.loadoutMap };
        },
        on: () => () => {},
    },
}));

vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => ({ actionTime: 10, totalEfficiency: 0 }),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'actionQueue',
        getSettingValue: (key, fallback) => {
            if (key === 'actionQueue_valueMode') return game.valueMode;
            if (key === 'actionQueue_showValue') return game.showValue;
            return fallback;
        },
        COLOR_TOOLTIP_INFO: '#abc',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    // Not loaded, so nothing but the combat rows can contribute to the value total
    default: { isLoaded: () => false, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateEnhancementPredictions: () => null }));

vi.mock('../../utils/all-zones-snapshot.js', async (importOriginal) => ({
    ...(await importOriginal()),
    loadAllZonesSnapshot: async () => game.snapshot,
    loadZoneSimRates: async () => game.rates,
}));

const { default: actionTimeDisplay, estimateCombatQueueRow } = await import('./action-time-display.js');

const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;
const GOBO = '/actions/combat/gobo_planet';
const COMBAT_ID = 41704;

const gobo = { hrid: GOBO, name: 'Gobo Planet', type: '/action_types/combat', combatZoneInfo: { isDungeon: false } };

/** A fight with 1000 waves left, which at 500 waves an hour is two hours. */
function combatAction(id, { maxCount = 1080, currentCount = 80, tier = 3, loadoutId = COMBAT_ID } = {}) {
    return {
        id,
        ordinal: id,
        actionHrid: GOBO,
        difficultyTier: tier,
        characterLoadoutID: loadoutId,
        primaryItemHash: '',
        hasMaxCount: maxCount > 0,
        maxCount,
        currentCount,
    };
}

function snapshot({ rate = 500, profitPerHour = 1_000_000, tier = 3 } = {}) {
    return {
        savedAt: NOW - 3 * HOUR,
        fingerprint: 'abc',
        loadout: { source: 'loadout', name: 'Combat' },
        zones: [
            {
                zoneHrid: GOBO,
                zoneName: 'Gobo Planet',
                difficultyTier: tier,
                ...(profitPerHour === null ? {} : { profitPerHour }),
                xpPerHour: 50_000,
                ...(rate === null ? {} : { encountersPerHour: rate }),
            },
        ],
    };
}

/** The edit menu as the game draws it, one row per label. */
function queueMenu(labels) {
    const parent = document.createElement('div');
    const menu = document.createElement('div');
    menu.className = 'QueuedActions_queuedActionsEditMenu__x';
    menu.innerHTML = labels
        .map(
            (label, index) => `
        <div class="QueuedActions_action__item">
            <div class="QueuedActions_actionText__y">
                <div class="QueuedActions_text__z">#${index + 1}${label}</div>
            </div>
        </div>`
        )
        .join('');
    parent.appendChild(menu);
    document.body.appendChild(parent);
    return menu;
}

const profits = (root) => [...root.querySelectorAll('.mwi-queue-action-profit')].map((el) => el.textContent);
const totalText = () => document.querySelector('#mwi-queue-total-time')?.textContent ?? '';
const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe('estimateCombatQueueRow carries the profit its rate came with', () => {
    const estimate = (overrides = {}) =>
        estimateCombatQueueRow({
            actionObj: combatAction(1),
            actionDetails: gobo,
            snapshot: snapshot(),
            rowLoadout: { known: true, name: 'Combat' },
            now: NOW,
            ...overrides,
        });

    test('a counted row gets the run total and the rate it rests on', () => {
        const result = estimate();
        expect(result.seconds).toBe(7200);
        expect(result.profitPerHour).toBe(1_000_000);
        expect(result.profitTotal).toBe(2_000_000);
    });

    test('a Fight ∞ row has a rate but no total', () => {
        const result = estimate({ actionObj: combatAction(1, { maxCount: 0 }) });
        expect(result.kind).toBe('infinite');
        expect(result.profitPerHour).toBe(1_000_000);
        expect(result.profitTotal).toBeNull();
    });

    test('a row with no rate has neither, and never a zero', () => {
        const result = estimate({ snapshot: snapshot({ rate: null }) });
        expect(result.kind).toBe('unknown');
        expect(result.profitPerHour).toBeNull();
        expect(result.profitTotal).toBeNull();
    });

    test('a reading that carried no profit gives no total', () => {
        // Same shape a run written before the field, or one taken with no market data, leaves
        const result = estimate({ snapshot: snapshot({ profitPerHour: null }) });
        expect(result.kind).toBe('unknown');
        expect(result.profitTotal).toBeNull();
    });

    test('the flags the header button reads freshness from ride along', () => {
        expect(estimate().rateFlags).toEqual([]);
        expect(estimate({ rowLoadout: { known: true, name: 'Tank' } }).rateFlags).toEqual(['other gear']);
        expect(estimate({ snapshot: snapshot({ rate: null }) }).rateFlags).toBeNull();
    });
});

describe('the Queued Actions panel shows what a fight is expected to make', () => {
    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        document.body.innerHTML = '';
        game.actionDetails = { [GOBO]: gobo };
        game.loadoutMap = { [COMBAT_ID]: { name: 'Combat' } };
        game.snapshot = snapshot();
        game.rates = {};
        game.valueMode = 'profit';
        game.showValue = true;
        await actionTimeDisplay.refreshCombatSnapshot();
    });

    afterEach(() => {
        vi.useRealTimers();
        actionTimeDisplay._combatSnapshotCache = null;
        actionTimeDisplay._lastQueueMenu = null;
    });

    test('a counted row reads its total and its rate', async () => {
        game.currentActions = [combatAction(1)];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(profits(menu)).toEqual(['Profit: +2.00M (1.00M/hr)']);
        expect(totalText()).toContain('Total profit: +2.00M');
        expect(totalText()).not.toContain('[?]');
        // Nothing failed to draw
        expect(menu.textContent).not.toContain('undefined');
    });

    test('a Fight ∞ row reads the rate alone, and the total says it is short', async () => {
        game.currentActions = [combatAction(1), combatAction(2, { maxCount: 0 })];
        const menu = queueMenu(['Gobo Planet (T3)', 'Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(profits(menu)).toEqual(['Profit: +2.00M (1.00M/hr)', 'Profit: +1.00M/hr']);
        expect(totalText()).toContain('Total profit: +2.00M + [?]');
    });

    test('a row with no rate shows no figure at all', async () => {
        game.snapshot = snapshot({ rate: null });
        await actionTimeDisplay.refreshCombatSnapshot();
        game.currentActions = [combatAction(1)];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(profits(menu)).toEqual([]);
        expect(totalText()).toBe('Total time: [?]');
    });

    test('a zone that loses money reads as a loss, not as a bug', async () => {
        game.snapshot = snapshot({ profitPerHour: -500_000 });
        await actionTimeDisplay.refreshCombatSnapshot();
        game.currentActions = [combatAction(1)];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(profits(menu)).toEqual(['Profit: -1.00M (-500.00K/hr)']);
        expect(totalText()).toContain('Total profit: -1.00M');
    });

    // Regression for the live-observed bug: the panel's own capped formatLargeNumber
    // (removed) hard-stopped at 'M', so a trillion-scale total like this one printed as
    // "1953652.64M" instead of "1.95T" — the crafting/action panels, which already used the
    // shared formatters.js formatLargeNumber, read it correctly the whole time.
    test('a trillion-scale total reads in T, not a giant M figure', async () => {
        // 1000 waves at 500/hr is 2 hours (see combatAction's own comment), so a
        // profitPerHour of 975B doubles to a 1.95T total.
        game.snapshot = snapshot({ profitPerHour: 975_000_000_000 });
        await actionTimeDisplay.refreshCombatSnapshot();
        game.currentActions = [combatAction(1)];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(profits(menu)).toEqual(['Profit: +1.95T (975.00B/hr)']);
        expect(profits(menu)[0]).not.toContain('M');
        expect(totalText()).toContain('Total profit: +1.95T');
        expect(totalText()).not.toContain('M');
    });

    test('nothing is shown with the panel’s value toggle off', async () => {
        game.showValue = false;
        game.currentActions = [combatAction(1)];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(profits(menu)).toEqual([]);
        expect(totalText()).toBe('Total time: ~2h 00m 00s');
    });

    test('nothing is shown in estimated-value mode, which a net rate cannot answer', async () => {
        game.valueMode = 'estimated_value';
        game.currentActions = [combatAction(1)];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(profits(menu)).toEqual([]);
        expect(totalText()).toBe('Total time: ~2h 00m 00s');
    });
});
