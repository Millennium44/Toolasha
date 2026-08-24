/**
 * @vitest-environment happy-dom
 *
 * The Fixed Assets tree, and specifically the guild shrine row in it.
 *
 * Shrine levels are the one part of net worth that may simply not be known:
 * they ride on guild traffic that a session can go without ever seeing. A row
 * reading zero would be a claim the character has bought no shrine levels,
 * which is a different statement from "nobody has told us yet", so the rule
 * under test is that no row is drawn at all until there is something to draw.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#5b8def',
        COLOR_TEXT_SECONDARY: '#999',
        getSetting: () => false,
        getSettingValue: () => null,
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => null } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null } }));
vi.mock('./networth-history-chart.js', () => ({
    default: { toggleModal: () => {} },
    CHART_BUTTON_ID: 'mwi-networth-chart-btn',
}));
vi.mock('./gold-sources-panel.js', () => ({
    default: { toggleModal: () => {}, closeModal: () => {} },
    BUTTON_ID: 'mwi-gold-sources-btn',
}));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: { isInitialized: false, calculateExpectedValue: () => null },
}));
vi.mock('../../utils/dungeon-keys.js', () => ({ DUNGEON_CHEST_CHEST_KEYS: {} }));
vi.mock('./networth-exclusion-popup.js', () => ({ default: { open: () => {} } }));
vi.mock('./networth-exclusions.js', () => ({ removeExclusion: async () => {} }));

const { networthInventoryDisplay } = await import('./networth-display.js');

/**
 * Net worth data with only the fields the panel reads.
 * @param {Object} guildShrines - The `fixedAssets.guildShrines` block, or undefined
 * @returns {Object} networthData
 */
function networthData(guildShrines) {
    return {
        totalNetworth: 1_000_000,
        coins: 0,
        excluded: { total: 0, items: [] },
        currentAssets: {
            total: 0,
            equipped: { value: 0, breakdown: [] },
            inventory: { value: 0, breakdown: [], byCategory: {} },
            listings: { value: 0, breakdown: [] },
        },
        fixedAssets: {
            total: 1_000_000,
            houses: { totalCost: 1_000_000, breakdown: [{ hrid: '/house_rooms/dojo', name: 'Dojo', level: 2 }] },
            abilities: { totalCost: 0, equippedCost: 0, breakdown: [], equippedBreakdown: [], otherBreakdown: [] },
            abilityBooks: { totalCost: 0, breakdown: [] },
            guildShrines,
        },
    };
}

/** Render the panel and hand back its text. @returns {string} Panel text */
function panelText() {
    return networthInventoryDisplay.container.textContent;
}

beforeEach(() => {
    document.body.innerHTML = '';
    const container = document.createElement('div');
    document.body.appendChild(container);
    networthInventoryDisplay.container = container;
    networthInventoryDisplay.currentData = null;
});

describe('guild shrines row', () => {
    test('is drawn under Fixed Assets once levels are known', () => {
        networthInventoryDisplay.update(
            networthData({
                totalCost: 52_500,
                tokens: 60,
                known: true,
                breakdown: [
                    { hrid: '/guild_buffs/force_combat', name: 'Force Combat 3', level: 3, cost: 52_500, tokens: 60 },
                ],
            })
        );

        expect(panelText()).toContain('Guild Shrines');
        // The row sits inside the Fixed Assets subtree, beside Houses
        expect(networthInventoryDisplay.container.querySelector('#mwi-fixed-assets-details')).not.toBeNull();
        expect(networthInventoryDisplay.container.querySelector('#mwi-guild-shrines-toggle')).not.toBeNull();
    });

    test('the breakdown names each shrine, its gold, and its tokens', () => {
        networthInventoryDisplay.update(
            networthData({
                totalCost: 55_500,
                tokens: 65,
                known: true,
                breakdown: [
                    { hrid: '/guild_buffs/force_combat', name: 'Force Combat 3', level: 3, cost: 52_500, tokens: 60 },
                    {
                        hrid: '/guild_buffs/scholar_skilling',
                        name: 'Scholar Skilling 1',
                        level: 1,
                        cost: 3000,
                        tokens: 5,
                    },
                ],
            })
        );

        const breakdown = networthInventoryDisplay.container.querySelector('#mwi-guild-shrines-breakdown').textContent;
        expect(breakdown).toContain('Force Combat 3');
        expect(breakdown).toContain('Scholar Skilling 1');
        expect(breakdown).toContain('60 tokens');
    });

    test('unknown shrine levels draw no row rather than a zero', () => {
        networthInventoryDisplay.update(networthData({ totalCost: 0, tokens: 0, breakdown: [], known: false }));

        expect(panelText()).not.toContain('Guild Shrines');
        expect(networthInventoryDisplay.container.querySelector('#mwi-guild-shrines-toggle')).toBeNull();
    });

    test('a character in no guild, with every shrine at zero, gets no row either', () => {
        networthInventoryDisplay.update(networthData({ totalCost: 0, tokens: 0, breakdown: [], known: true }));

        expect(panelText()).not.toContain('Guild Shrines');
    });

    test('data from before shrines were tracked at all renders without throwing', () => {
        expect(() => networthInventoryDisplay.update(networthData(undefined))).not.toThrow();
        expect(panelText()).toContain('Houses');
        expect(panelText()).not.toContain('Guild Shrines');
    });
});

describe('an inventory item nothing can price', () => {
    test('says so rather than drawing a zero', () => {
        // Task tokens are priced through the Task Shop, and before that can be read
        // they contribute nothing — which is not the same as being worth nothing
        const html = networthInventoryDisplay.renderInventoryBreakdown({
            byCategory: {
                Currencies: {
                    totalValue: 0,
                    items: [
                        {
                            name: 'Task Token',
                            count: 400,
                            value: 0,
                            itemHrid: '/items/task_token',
                            unpriced: true,
                        },
                    ],
                },
            },
            breakdown: [],
        });

        expect(html).toContain('no price');
        expect(html).not.toContain('Task Token x400: 0');
    });

    test('an item that really is worth nothing still draws its figure', () => {
        const html = networthInventoryDisplay.renderInventoryBreakdown({
            byCategory: {
                Other: {
                    totalValue: 0,
                    items: [{ name: 'Junk', count: 2, value: 0, itemHrid: '/items/junk', unpriced: false }],
                },
            },
            breakdown: [],
        });

        expect(html).not.toContain('no price');
    });
});
