/**
 * @vitest-environment happy-dom
 *
 * The party-stats cache in front of `combatStatsDataCollector`.
 *
 * The collector itself already clears its `latestCombatData` synchronously on
 * `character_switching` (see combat-stats-data-collector.test.js) — this file
 * tests the *second*, closer cache that `partyStats()` keeps on top of it, for
 * up to `CACHE_MS`. That cache used to survive a character switch untouched,
 * so Combat Revenue, Experience/hr, Deaths/hr and Total Profit could all go on
 * showing the outgoing character's figures under the incoming character's
 * name for up to four seconds after a switch.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    dmHandlers: {},
    actions: [],
    profitView: null,
    forecasts: [],
    partySummary: null,
    outlook: null,
    consumableSides: { ask: 0, bid: 0, askUnpriced: 0, bidUnpriced: 0, askUnknown: 0, bidUnknown: 0 },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.actions,
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: () => {},
    },
}));

const collector = vi.hoisted(() => ({ data: null }));
vi.mock('./combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => collector.data },
}));

// The real calculator prices a loot map through the market; a stub keeps this
// file about the cache rather than about pricing arithmetic
vi.mock('./combat-stats-calculator.js', () => ({
    calculatePlayerStats: (player) => ({
        name: player.name,
        isCurrentPlayer: player.isCurrentPlayer,
        expPerHour: player.isCurrentPlayer ? player.expPerHour : 0,
        deathsPerHour: player.deathsPerHour ?? 0,
        dailyIncome: { bid: 0, ask: 0, value: 0 },
        dailyProfit: { bid: 0, ask: 0, value: (player.income ?? 0) * 10 },
        dailyConsumableCosts: 0,
        dailyConsumableCostsValue: 0,
        dailyKeyCosts: 0,
        income: { bid: player.income ?? 0, value: player.income ?? 0 },
        consumableCosts: { bid: 0, value: 0 },
        keyCosts: { bid: 0, value: 0 },
        consumableBreakdown: player.consumableBreakdown || [],
    }),
    describeLuckAdjustment: () => '',
}));

vi.mock('../../utils/bundle-bridge.js', () => ({
    combatProfitView: () => game.profitView,
    profitPanel: () => null,
    combatLevelPanel: () => null,
    deathsPanel: () => null,
    partyLootPanel: () => null,
    consumablesPanel: () => null,
}));

vi.mock('../../utils/market-data.js', () => ({ getItemPrices: () => null }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/consumable-forecast.js', () => ({
    forecastAll: (breakdown) => (typeof game.forecasts === 'function' ? game.forecasts(breakdown) : game.forecasts),
    costPerDaySides: () => game.consumableSides,
    partyOutlook: () => game.partySummary || { you: game.outlook, party: null, partyName: null },
    drinkRatePerDay: () => 0,
}));
vi.mock('../../utils/consumable-target.js', () => ({
    currentTarget: () => ({ seconds: 86400 }),
    loadTarget: () => {},
}));

const rowsByKey = vi.hoisted(() => new Map());
vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => rowsByKey.set(definition.key, definition),
}));

await import('./combat-stats-rows.js');

/** Render one registered row's tile and read back its text */
function renderRow(key) {
    const container = document.createElement('div');
    rowsByKey.get(key).render(container);
    return container.textContent;
}

/** One registered row's `version()`, as the panel would call it */
function versionOf(key) {
    return rowsByKey.get(key).version();
}

/** A run with one player in it */
function run(player, extra = {}) {
    return { durationSeconds: 600, players: [{ isCurrentPlayer: true, ...player }], ...extra };
}

beforeEach(() => {
    collector.data = null;
    game.actions = [];
    game.profitView = null;
    game.forecasts = [];
    game.partySummary = null;
    game.outlook = null;
    game.consumableSides = { ask: 0, bid: 0, askUnpriced: 0, bidUnpriced: 0, askUnknown: 0, bidUnknown: 0 };
    // partyStats() and the consumable forecast both cache at module level for
    // CACHE_MS of real time, so whatever the previous test rendered is still
    // the answer when the next one asks. character_switching is the module's
    // own reset hook for exactly that state — use it rather than reaching in.
    game.dmHandlers.character_switching();
});

describe('the party-stats cache clears on a character switch', () => {
    test('a row fed by partyStats() stops showing the outgoing character once character_switching fires', () => {
        collector.data = {
            durationSeconds: 600,
            players: [{ name: 'Alice', isCurrentPlayer: true, expPerHour: 12345 }],
        };
        expect(renderRow('experiencePerHour')).toContain('12,345');

        // The collector's own data is gone the instant character_switching
        // fires — the overlay panel's redraw during the gap before the new
        // character's own run has loaded sees this, not a stale run
        collector.data = null;
        game.dmHandlers.character_switching();

        expect(renderRow('experiencePerHour')).not.toContain('12,345');
    });

    test('a fresh read after the switch reflects the arriving character, not a cached one', () => {
        collector.data = {
            durationSeconds: 600,
            players: [{ name: 'Alice', isCurrentPlayer: true, expPerHour: 12345 }],
        };
        renderRow('experiencePerHour');

        game.dmHandlers.character_switching();
        collector.data = {
            durationSeconds: 600,
            players: [{ name: 'Bob', isCurrentPlayer: true, expPerHour: 999 }],
        };

        expect(renderRow('experiencePerHour')).toContain('999');
        expect(renderRow('experiencePerHour')).not.toContain('12,345');
    });
});

/**
 * The rows' `version()` functions.
 *
 * The overlay redraws every visible tile once a second, and a row that can
 * summarise its own inputs is a whole render — compute and DOM rebuild — the
 * panel skips. What that buys is only safe if the summary covers *everything*
 * the render reads, so each test here moves one input and insists the summary
 * moves with it, and holds every input still and insists it does not.
 */
describe('the rows summarise their own inputs', () => {
    beforeEach(() => {
        // The party-stats cache lives for CACHE_MS, so a test that changes the
        // collector's data has to get past it; clearing is what a switch does
        game.dmHandlers.character_switching();
    });

    test('Experience/hr holds still while the figure does, and moves when it moves', () => {
        collector.data = run({ name: 'Alice', expPerHour: 12345 });
        const first = versionOf('experiencePerHour');
        expect(versionOf('experiencePerHour')).toBe(first);

        game.dmHandlers.character_switching();
        collector.data = run({ name: 'Alice', expPerHour: 12345 });
        expect(versionOf('experiencePerHour')).toBe(first);

        game.dmHandlers.character_switching();
        collector.data = run({ name: 'Alice', expPerHour: 999 });
        expect(versionOf('experiencePerHour')).not.toBe(first);
    });

    test('a version that never changes is never allowed to hide a render', () => {
        // The panel's contract: an unchanged version keeps what is on the tile.
        // So a row whose figure moved must not report the version it reported
        // before it moved — this is the failure mode the memo has to not have.
        collector.data = run({ name: 'Alice', expPerHour: 100 });
        const before = versionOf('experiencePerHour');

        game.dmHandlers.character_switching();
        collector.data = run({ name: 'Alice', expPerHour: 101 });

        expect(versionOf('experiencePerHour')).not.toBe(before);
        expect(renderRow('experiencePerHour')).toContain('101');
    });

    test('Deaths/hr tells a rounded-away death from no death at all', () => {
        // 0.04 draws as "0.0" and is still colored as a death, so the color is
        // an input of its own — a version keyed on the text alone would freeze it
        collector.data = run({ name: 'Alice', deathsPerHour: 0 });
        const none = versionOf('deathsPerHour');

        game.dmHandlers.character_switching();
        collector.data = run({ name: 'Alice', deathsPerHour: 0.04 });

        expect(versionOf('deathsPerHour')).not.toBe(none);
    });

    test('Combat Status keys on the action that is running', () => {
        game.actions = [];
        const idle = versionOf('combatStatus');

        game.actions = [{ actionHrid: '/actions/combat/fly', isDone: false }];
        const fighting = versionOf('combatStatus');
        expect(fighting).not.toBe(idle);

        // A different fight is a different action, and a finished one is not the
        // one being drawn
        game.actions = [
            { actionHrid: '/actions/combat/fly', isDone: true },
            { actionHrid: '/actions/cheesesmithing/bronze_bar', isDone: false },
        ];
        expect(versionOf('combatStatus')).not.toBe(fighting);
        expect(renderRow('combatStatus')).toContain('Skilling');
    });

    test('Combat Revenue moves when the panel changes its reading, not only its figures', () => {
        // Pricing mode, the costs switch and the MooPass switch are panel
        // buttons that move the tile without the run's own figures moving at
        // all; a version keyed on the collector alone would show the reading
        // you just switched away from
        collector.data = run({ name: 'Alice' });
        game.profitView = () => ({ title: 'Lazy Profit', revenue: 100, cost: 10, tax: 0, profit: 90 });
        const lazy = versionOf('combatRevenue');

        game.profitView = () => ({ title: 'Patient Profit', revenue: 120, cost: 10, tax: 0, profit: 110 });
        expect(versionOf('combatRevenue')).not.toBe(lazy);
    });

    test('Total Profit moves when any party member’s banked figure does', () => {
        collector.data = {
            durationSeconds: 600,
            players: [
                { name: 'Alice', isCurrentPlayer: true, income: 1000 },
                { name: 'Bob', isCurrentPlayer: false, income: 500 },
            ],
        };
        const before = versionOf('totalProfit');
        expect(versionOf('totalProfit')).toBe(before);

        game.dmHandlers.character_switching();
        collector.data = {
            durationSeconds: 600,
            players: [
                { name: 'Alice', isCurrentPlayer: true, income: 1000 },
                { name: 'Bob', isCurrentPlayer: false, income: 600 },
            ],
        };
        expect(versionOf('totalProfit')).not.toBe(before);
    });

    test('a tile with nothing to draw settles on one version and stays there', () => {
        collector.data = null;
        for (const key of ['combatRevenue', 'experiencePerHour', 'deathsPerHour', 'totalProfit', 'consumables']) {
            expect(versionOf(key)).toBe(versionOf(key));
        }
    });

    test('the Consumables tile preserves the unknown part of daily market totals', () => {
        collector.data = run({ name: 'Alice', consumableBreakdown: [{ itemHrid: '/items/blackberry_cake' }] });
        game.forecasts = [{ itemHrid: '/items/blackberry_cake', secondsLeft: 3600 }];
        game.outlook = { itemHrid: '/items/blackberry_cake', held: 10, rateKnown: true, secondsLeft: 3600 };
        game.consumableSides = { ask: 2400, bid: 2160, askUnpriced: 1, bidUnpriced: 1 };

        const initial = versionOf('consumables');
        expect(renderRow('consumables')).toContain('Ask: 2.40K (1 unpriced)\nBid: 2.16K (1 unpriced)');

        game.consumableSides = { ask: null, bid: null, askUnpriced: 2, bidUnpriced: 2 };
        game.dmHandlers.character_switching();
        expect(versionOf('consumables')).not.toBe(initial);
        expect(renderRow('consumables')).toContain('Ask: — (2 unpriced)\nBid: — (2 unpriced)');
    });

    test('the consumables tile stays visible when rates are unknown', () => {
        collector.data = run({ name: 'Alice', consumableBreakdown: [{ itemHrid: '/items/blackberry_cake' }] });
        game.forecasts = [
            {
                itemHrid: '/items/blackberry_cake',
                name: 'Blackberry Cake',
                held: 14,
                rateKnown: false,
                secondsLeft: null,
            },
        ];
        game.outlook = null;
        game.consumableSides = {
            ask: null,
            bid: null,
            askUnpriced: 0,
            bidUnpriced: 0,
            askUnknown: 1,
            bidUnknown: 1,
        };

        expect(versionOf('consumables')).not.toBe('blank');
        expect(renderRow('consumables')).toContain('rate unknown');
        expect(renderRow('consumables')).toContain('Ask: — (1 rate unknown)');
    });

    test('the tile marks a known countdown as partial when another rate is unknown', () => {
        collector.data = run({ name: 'Alice', consumableBreakdown: [{ itemHrid: '/items/blackberry_cake' }] });
        game.forecasts = [
            {
                itemHrid: '/items/spaceberry_cake',
                name: 'Spaceberry Cake',
                held: 100,
                rateKnown: true,
                secondsLeft: 900,
            },
            {
                itemHrid: '/items/blackberry_cake',
                name: 'Blackberry Cake',
                held: 14,
                rateKnown: false,
                secondsLeft: null,
            },
        ];
        game.outlook = { itemHrid: '/items/spaceberry_cake', held: 100, rateKnown: true, secondsLeft: 900 };
        game.consumableSides = {
            ask: 2400,
            bid: 2160,
            askUnpriced: 0,
            bidUnpriced: 0,
            askUnknown: 1,
            bidUnknown: 1,
        };
        game.dmHandlers.character_switching();

        expect(renderRow('consumables')).toContain('15m + ?');
        expect(renderRow('consumables')).toContain('Ask: 2.40K (1 rate unknown)');
    });

    test('the version changes when a party member gains an unknown rate beside the same limiter', () => {
        collector.data = {
            durationSeconds: 600,
            players: [
                { name: 'Alice', isCurrentPlayer: true, consumableBreakdown: [{ itemHrid: '/items/spaceberry_cake' }] },
                {
                    name: 'Bob',
                    consumableBreakdown: [
                        { itemHrid: '/items/blackberry_cake' },
                        { itemHrid: '/items/spaceberry_cake' },
                    ],
                },
            ],
        };
        let partyRateKnown = true;
        game.forecasts = (breakdown) => {
            const isParty = breakdown[0].itemHrid === '/items/blackberry_cake';
            const entries = [
                {
                    itemHrid: breakdown[0].itemHrid,
                    name: isParty ? 'Blackberry Cake' : 'Spaceberry Cake',
                    held: isParty ? 20 : 10,
                    rateKnown: isParty ? partyRateKnown : true,
                    secondsLeft: isParty ? (partyRateKnown ? 1800 : null) : 900,
                },
            ];
            if (isParty) {
                entries.push({
                    itemHrid: '/items/spaceberry_cake',
                    name: 'Spaceberry Cake',
                    held: 10,
                    rateKnown: true,
                    secondsLeft: 1200,
                });
            }
            return entries;
        };
        game.outlook = {
            itemHrid: '/items/spaceberry_cake',
            held: 10,
            rateKnown: true,
            secondsLeft: 900,
        };
        game.partySummary = {
            you: game.outlook,
            party: { itemHrid: '/items/spaceberry_cake', held: 10, rateKnown: true, secondsLeft: 1200 },
            partyName: 'Bob',
        };

        const before = versionOf('consumables');
        partyRateKnown = false;
        game.dmHandlers.character_switching();
        const after = versionOf('consumables');

        expect(after).not.toBe(before);
        expect(renderRow('consumables')).toContain('20m + ?');
    });
});
