/**
 * @vitest-environment happy-dom
 *
 * Experience/hr and Total Profit while a skilling action runs.
 *
 * Both tiles were combat figures. They now answer for the running skilling
 * action instead, and go back to the combat reading the moment a fight is the
 * thing running, or nothing is. The cases that matter are the ones that touch
 * both: what each tile draws and says when it has nothing yet.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    handlers: {},
    actions: [],
    details: {},
    reading: null,
    bridgeUp: true,
    gather: null,
    produce: null,
    settings: { profitCalc_pricingMode: 'hybrid', profitCalc_excludeSellTax: false },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.actions,
        getActionDetails: (hrid) => game.details[hrid],
        getCurrentCharacterId: () => 'char1',
        on: (event, handler) => {
            // Two modules listen for the switch; keep both
            (game.handlers[event] ||= []).push(handler);
        },
        off: () => {},
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => game.settings[key] ?? fallback,
        getSetting: () => true,
    },
}));

const collector = vi.hoisted(() => ({ data: null }));
vi.mock('./combat-stats-data-collector.js', () => ({ default: { getLatestData: () => collector.data } }));
vi.mock('./combat-stats-calculator.js', () => ({
    valueOfLoot: () => ({ ask: 0, bid: 0, value: 0 }),
    calculatePlayerStats: (player) => ({
        name: player.name,
        isCurrentPlayer: player.isCurrentPlayer,
        expPerHour: 12345,
        deathsPerHour: 0,
        dailyIncome: { bid: 0, ask: 0, value: 0 },
        dailyProfit: { bid: 0, ask: 0, value: 100 },
        income: { bid: 10, value: 10 },
        consumableCosts: { bid: 0, value: 0 },
        keyCosts: { bid: 0, value: 0 },
        consumableBreakdown: [],
    }),
    describeLuckAdjustment: () => '',
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    marketDepthCap: () => null,
    guildMemberSkills: () => null,
    combatProfitView: () => null,
    profitPanel: () => null,
    combatLevelPanel: () => null,
    deathsPanel: () => null,
    partyLootPanel: () => null,
    consumablesPanel: () => null,
    skillTtlRow: () => (game.bridgeUp ? { runningSkillReading: () => game.reading } : null),
    gatheringProfit: () => (game.bridgeUp ? { calculateGatheringProfit: (...args) => game.gather(...args) } : null),
    productionProfit: () => (game.bridgeUp ? { calculateProductionProfit: (...args) => game.produce(...args) } : null),
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: () => null }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/consumable-forecast.js', () => ({
    forecastAll: () => [],
    costPerDaySides: () => ({ ask: 0, bid: 0, askUnpriced: 0, bidUnpriced: 0, askUnknown: 0, bidUnknown: 0 }),
    partyOutlook: () => ({ you: null, party: null, partyName: null }),
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

const FORAGING = '/actions/foraging/star_fruit';
const COMBAT = '/actions/combat/golem_cave';
const ENHANCING = '/actions/enhancing/enhance';

/** Draw one registered row and give back what it left on the tile */
function draw(key) {
    const container = document.createElement('div');
    rowsByKey.get(key).render(container);
    return container;
}

const emptyText = (key) => {
    const empty = rowsByKey.get(key).empty;
    return typeof empty === 'function' ? empty() : empty;
};

async function settle() {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

function run(actionHrid, type, name) {
    game.details[actionHrid] = { type, name };
    game.actions = [{ actionHrid, isDone: false, ordinal: 0 }];
}

beforeEach(() => {
    collector.data = { durationSeconds: 600, players: [{ name: 'Alice', isCurrentPlayer: true }] };
    game.actions = [];
    game.details = {};
    game.reading = null;
    game.bridgeUp = true;
    game.gather = vi.fn(async () => ({ profitPerHour: 1_310_000, hasMissingPrices: false, pricingMode: 'hybrid' }));
    game.produce = vi.fn(async () => null);
    game.settings = { profitCalc_pricingMode: 'hybrid', profitCalc_excludeSellTax: false };
    for (const handler of game.handlers.character_switching) handler();
});

describe('Experience/hr', () => {
    test('shows the running skill’s rate with its name, from the Time to Level window', () => {
        run(FORAGING, '/action_types/foraging', 'Star Fruit');
        game.reading = { hrid: '/skills/foraging', name: 'Foraging', xpPerHour: 42300 };

        const tile = draw('experiencePerHour');
        expect(tile.textContent).toContain('42,300 exp/hr');
        expect(tile.textContent).toContain('Foraging');
        expect(tile.textContent).not.toContain('12,345');
        expect(tile.title).toContain('Time to Level');
    });

    test('is empty until two readings exist, and says it is measuring', () => {
        run(FORAGING, '/action_types/foraging', 'Star Fruit');
        game.reading = { hrid: '/skills/foraging', name: 'Foraging', xpPerHour: null };

        expect(draw('experiencePerHour').textContent).toBe('');
        expect(emptyText('experiencePerHour')).toBe('Measuring experience rate…');
    });

    test('its version moves with the rate and with the skill', () => {
        const version = rowsByKey.get('experiencePerHour').version;
        run(FORAGING, '/action_types/foraging', 'Star Fruit');
        game.reading = { hrid: '/skills/foraging', name: 'Foraging', xpPerHour: null };
        const measuring = version();
        game.reading = { hrid: '/skills/foraging', name: 'Foraging', xpPerHour: 42300 };
        const measured = version();
        game.reading = { hrid: '/skills/woodcutting', name: 'Woodcutting', xpPerHour: 42300 };

        expect(new Set([measuring, measured, version()]).size).toBe(3);
    });

    test('combat running, or nothing running, is today’s combat rendering', () => {
        // The reading is null whenever no skilling action runs
        game.reading = null;
        run(COMBAT, '/action_types/combat', 'Golem Cave');
        expect(draw('experiencePerHour').textContent).toBe('12,345 exp/hr');
        expect(emptyText('experiencePerHour')).toBe('No experience yet');

        game.actions = [];
        expect(draw('experiencePerHour').textContent).toBe('12,345 exp/hr');
    });

    test('with the ui bundle not up it stays on the combat reading rather than going blank', () => {
        game.bridgeUp = false;
        run(FORAGING, '/action_types/foraging', 'Star Fruit');
        expect(draw('experiencePerHour').textContent).toBe('12,345 exp/hr');
    });
});

describe('Total Profit', () => {
    test('while estimating it draws nothing and says so', () => {
        run(FORAGING, '/action_types/foraging', 'Star Fruit');

        expect(draw('totalProfit').textContent).toBe('');
        expect(emptyText('totalProfit')).toBe('Estimating profit…');
    });

    test('a priced estimate reads as the action, the hourly figure and est.', async () => {
        run(FORAGING, '/action_types/foraging', 'Star Fruit');
        draw('totalProfit');
        await settle();

        const tile = draw('totalProfit');
        expect(tile.textContent).toContain('Star Fruit');
        expect(tile.textContent).toContain('1.31M/hr');
        expect(tile.textContent).toContain('est.');
        expect(tile.textContent).not.toContain('partial');
        expect(tile.title).toContain('hybrid pricing');
    });

    test('a partly priced estimate says partial on the tile and in the tooltip', async () => {
        game.gather = vi.fn(async () => ({ profitPerHour: 400_000, hasMissingPrices: true, pricingMode: 'hybrid' }));
        run(FORAGING, '/action_types/foraging', 'Star Fruit');
        draw('totalProfit');
        await settle();

        const tile = draw('totalProfit');
        expect(tile.textContent).toContain('est. · partial');
        expect(tile.title).toContain('no market price');
    });

    test('a loss reads as a loss', async () => {
        game.gather = vi.fn(async () => ({ profitPerHour: -52_000, hasMissingPrices: false, pricingMode: 'hybrid' }));
        run(FORAGING, '/action_types/foraging', 'Star Fruit');
        draw('totalProfit');
        await settle();

        const tile = draw('totalProfit');
        expect(tile.textContent).toContain('-52.00K/hr');
        expect(tile.title).toContain('costs more than it earns');
    });

    test('an action with no estimate draws nothing and names the skill', () => {
        run(ENHANCING, '/action_types/enhancing', 'Enhance');

        expect(draw('totalProfit').textContent).toBe('');
        expect(emptyText('totalProfit')).toBe('No profit estimate for Enhancing');
    });

    test('its version moves when the estimate lands', async () => {
        const version = rowsByKey.get('totalProfit').version;
        run(FORAGING, '/action_types/foraging', 'Star Fruit');
        const pending = version();
        await settle();

        expect(version()).not.toBe(pending);
    });

    test('combat running, or nothing running, is today’s tracked-loot rendering', () => {
        run(COMBAT, '/action_types/combat', 'Golem Cave');
        expect(draw('totalProfit').textContent).toContain('Alice');
        expect(game.gather).not.toHaveBeenCalled();
        expect(emptyText('totalProfit')).toBe('No loot tracked yet');

        game.actions = [];
        expect(draw('totalProfit').textContent).toContain('Alice');
    });
});
