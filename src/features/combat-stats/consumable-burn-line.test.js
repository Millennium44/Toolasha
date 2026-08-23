/** @vitest-environment happy-dom */

/**
 * The "Consumables vs sim" line on the Combat Statistics popup.
 *
 * The arithmetic is tested in `utils/consumable-burn.test.js`; what these cover
 * is the join — that the popup finds the sim record for the zone it is showing,
 * puts the ratio where the consumable costs are, and stays silent in every case
 * where the comparison would be inventing evidence: no sim, the wrong zone, or
 * a party member the sim never simulated.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    live: null,
    byZone: {},
    actions: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_TEXT_PRIMARY: '#eee',
        COLOR_TEXT_SECONDARY: '#999',
        COLOR_TOOLTIP_PROFIT: '#5f5',
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback ?? null,
        getPricingModeLabel: () => 'Hybrid',
        onSettingChange: () => {},
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => ({ name: hrid.split('/').pop(), rarity: 0 }),
        getActionDetails: () => ({ name: 'Chimerical Den' }),
        getCurrentCharacterId: () => 'char-1',
        getCurrentCharacterName: () => 'Me',
        getCurrentActions: () => mocks.actions,
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: async () => ({}), getPrice: () => null },
}));
vi.mock('./combat-stats-data-collector.js', () => ({
    default: {
        getLatestData: () => mocks.live,
        loadLatestData: async () => null,
        resetConsumableTracking: async () => {},
    },
}));
vi.mock('./combat-session-history.js', () => ({ loadSessions: async () => [] }));
vi.mock('../../utils/key-cost.js', () => ({
    formatKeyCostNote: () => '',
    describeKeyCost: () => ({ unitCost: null }),
    getKeyPricingMode: () => 'ask',
}));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        isInitialized: false,
        getCachedValue: () => null,
        calculateSingleContainer: () => null,
        calculateExpectedValue: () => null,
    },
}));
vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_char-1`,
    readScoped: async (base, _store, fallback) => (base === 'simConsumableRatesByZone' ? mocks.byZone : fallback),
    writeScoped: async () => true,
}));

const { default: combatStatsUI } = await import('./combat-stats-ui.js');

const ZONE = '/actions/combat/chimerical_den';
const HOUR = 3600;

/** Two hours of eating 45 cakes and 12 coffees an hour */
const consumables = () => [
    {
        itemHrid: '/items/blueberry_cake',
        currentCount: 100,
        consumed: 90,
        actualConsumed: 90,
        elapsedSeconds: 2 * HOUR,
    },
    {
        itemHrid: '/items/swiftness_coffee',
        currentCount: 100,
        consumed: 24,
        actualConsumed: 24,
        elapsedSeconds: 2 * HOUR,
    },
];

const player = (name, isCurrentPlayer) => ({
    name,
    isCurrentPlayer,
    deathCount: 0,
    loot: { 1: { itemHrid: '/items/coin', count: 1000 } },
    experience: {},
    consumables: consumables(),
});

const popup = () => document.querySelector('.toolasha-combat-stats-popup');

beforeEach(() => {
    mocks.actions = [{ actionHrid: ZONE, difficultyTier: 0, isDone: false }];
    mocks.live = {
        battleId: 5,
        combatStartTime: null,
        durationSeconds: 2 * HOUR,
        actionHrid: ZONE,
        players: [player('Me', true)],
    };
    // The sim expected 25 cakes and 12 coffees an hour
    mocks.byZone = {
        [`${ZONE}|0`]: {
            zoneHrid: ZONE,
            difficultyTier: 0,
            savedAt: 1_700_000_000_000,
            perHour: { '/items/blueberry_cake': 25, '/items/swiftness_coffee': 12 },
        },
    };
    vi.stubGlobal('alert', vi.fn());
});

afterEach(() => {
    combatStatsUI.closePopup();
    combatStatsUI.viewing = 'live';
    combatStatsUI.burnContext = null;
    vi.unstubAllGlobals();
});

describe('the consumables-vs-sim line', () => {
    test('draws the ratio for both categories with the measured window', async () => {
        await combatStatsUI.showPopup();

        const text = popup().textContent;
        expect(text).toContain('Consumables vs sim');
        expect(text).toContain('food 1.8× sim');
        expect(text).toContain('drinks 1.0× sim');
        expect(text).toContain('2h measured');
        // Nothing failed to draw around it
        expect(text).toContain('Daily Consumable Costs');
    });

    test('says the downstream profit inherits the gap', async () => {
        await combatStatsUI.showPopup();

        const line = [...popup().querySelectorAll('div')].find((div) =>
            div.textContent.startsWith('Consumables vs sim:')
        );
        expect(line.title).toContain('inherits');
    });

    test('is silent when no sim has been run for the zone', async () => {
        mocks.byZone = {};
        await combatStatsUI.showPopup();
        expect(popup().textContent).not.toContain('Consumables vs sim');
    });

    test('is silent when the sim on record is for another tier', async () => {
        mocks.actions = [{ actionHrid: ZONE, difficultyTier: 3, isDone: false }];
        await combatStatsUI.showPopup();
        expect(popup().textContent).not.toContain('Consumables vs sim');
    });

    test('is silent when the run has not been measured for long', async () => {
        mocks.live.players = [
            {
                ...player('Me', true),
                consumables: [
                    { itemHrid: '/items/blueberry_cake', consumed: 4, actualConsumed: 4, elapsedSeconds: 300 },
                ],
            },
        ];
        await combatStatsUI.showPopup();
        expect(popup().textContent).not.toContain('Consumables vs sim');
    });

    test('judges only the character the sim was run for', async () => {
        mocks.live.players = [player('Me', true), player('Ally', false)];
        await combatStatsUI.showPopup();

        const lines = [...popup().querySelectorAll('div')].filter((div) =>
            div.textContent.startsWith('Consumables vs sim:')
        );
        expect(lines).toHaveLength(1);
    });
});
