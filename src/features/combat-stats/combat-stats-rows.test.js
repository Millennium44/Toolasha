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

const game = vi.hoisted(() => ({ dmHandlers: {}, actions: [] }));

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
        deathsPerHour: 0,
        dailyIncome: { bid: 0, ask: 0 },
        dailyProfit: { bid: 0, ask: 0 },
        dailyConsumableCosts: 0,
        dailyKeyCosts: 0,
        income: { bid: 0 },
        consumableCosts: { bid: 0 },
        keyCosts: { bid: 0 },
    }),
    describeLuckAdjustment: () => '',
}));

vi.mock('../../utils/bundle-bridge.js', () => ({
    combatProfitView: () => null,
    profitPanel: () => null,
    combatLevelPanel: () => null,
    deathsPanel: () => null,
    partyLootPanel: () => null,
    consumablesPanel: () => null,
}));

vi.mock('../../utils/market-data.js', () => ({ getItemPrices: () => null }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/consumable-forecast.js', () => ({
    forecastAll: () => [],
    costPerDaySides: () => ({ ask: 0, bid: 0 }),
    partyOutlook: () => ({ you: null, party: null, partyName: null }),
    drinkRatePerDay: () => 0,
}));
vi.mock('../../utils/consumable-target.js', () => ({ currentTarget: () => null, loadTarget: () => {} }));

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

beforeEach(() => {
    collector.data = null;
    game.actions = [];
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
