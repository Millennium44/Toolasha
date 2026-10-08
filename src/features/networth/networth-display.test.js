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

describe('token worth breakdown', () => {
    /**
     * Net worth data holding tokens inside its inventory value.
     * @param {Array} items - `tokens.items`
     * @returns {Object} networthData
     */
    function withTokens(items) {
        const data = networthData(undefined);
        const counted = items.filter((item) => item.counted).reduce((sum, item) => sum + item.value, 0);
        data.currentAssets.total = 500_000;
        data.currentAssets.inventory.value = 500_000;
        data.totalNetworth = 1_500_000;
        data.tokens = { value: counted, items };
        return data;
    }

    const labyrinth = {
        itemHrid: '/items/labyrinth_token',
        name: 'Labyrinth Token',
        kind: 'labyrinth',
        count: 30,
        rate: 7000,
        value: 210_000,
        bestItemHrid: '/items/pathseeker_lodestone',
        bestItemName: 'Pathseeker Lodestone',
        note: null,
        counted: true,
        excludedBy: null,
        unpriced: false,
    };
    const guild = {
        itemHrid: '/items/guild_token',
        name: 'Guild Token',
        kind: 'guild',
        count: 5,
        rate: 4000,
        value: 20_000,
        bestItemHrid: '/items/guild_credit_1',
        bestItemName: 'Green Guild Credit',
        note: 'via credit exchange at 10 credits/token',
        counted: false,
        excludedBy: 'setting',
        unpriced: false,
    };

    test('sits under Current Assets, labelled as part of the inventory, without moving any total', () => {
        const data = withTokens([labyrinth, guild]);
        networthInventoryDisplay.update(data);

        const toggle = networthInventoryDisplay.container.querySelector('#mwi-tokens-toggle');
        expect(toggle).not.toBeNull();
        expect(networthInventoryDisplay.container.querySelector('#mwi-current-assets-details').contains(toggle)).toBe(
            true
        );
        expect(toggle.textContent).toContain('Tokens (in inventory)');
        expect(toggle.getAttribute('title')).toContain('Already counted in Inventory value');
        // The panel's totals are the calculator's, untouched by the breakdown
        expect(panelText()).toContain('Net Worth: 1.50M');
        expect(panelText()).toContain('Current Assets: 500.00K');
    });

    test('lists amount × best gold per token = total, naming the item, with the conversion in the hover text', () => {
        networthInventoryDisplay.update(withTokens([labyrinth]));

        const line = networthInventoryDisplay.container.querySelector('#mwi-tokens-breakdown .mwi-token-row');
        expect(line.textContent).toContain('Labyrinth Token x30 × 7.0K (Pathseeker Lodestone) = 210.00K');
        expect(line.textContent).not.toContain('(not counted)');
        expect(line.getAttribute('title')).toContain('If converted into Pathseeker Lodestone');
        expect(line.getAttribute('title')).toContain('sold at the best rate');
    });

    test('a token left out of net worth is greyed and says (not counted)', () => {
        networthInventoryDisplay.update(withTokens([labyrinth, guild]));

        const rows = [...networthInventoryDisplay.container.querySelectorAll('#mwi-tokens-breakdown .mwi-token-row')];
        const guildRow = rows.find((row) => row.textContent.includes('Guild Token'));
        expect(guildRow.textContent).toContain('Guild Token x5 × 4.0K (Green Guild Credit) = 20.00K (not counted)');
        expect(guildRow.style.opacity).toBe('0.5');
        expect(guildRow.getAttribute('title')).toContain('via credit exchange at 10 credits/token');
    });

    test('held tokens still show when nothing in Current Assets is counted', () => {
        const data = withTokens([guild]);
        data.currentAssets.total = 0;
        data.currentAssets.inventory.value = 0;
        networthInventoryDisplay.update(data);

        const toggle = networthInventoryDisplay.container.querySelector('#mwi-tokens-toggle');
        expect(toggle).not.toBeNull();
        expect(networthInventoryDisplay.container.querySelector('#mwi-tokens-breakdown').textContent).toContain(
            '(not counted)'
        );
        // And the section can be opened to reach it
        const details = networthInventoryDisplay.container.querySelector('#mwi-current-assets-details');
        expect(details.style.display).toBe('none');
        networthInventoryDisplay.container.querySelector('#mwi-current-assets-toggle').click();
        expect(details.style.display).not.toBe('none');
    });

    test('a token nothing can price says so', () => {
        networthInventoryDisplay.update(
            withTokens([{ ...labyrinth, rate: null, value: 0, unpriced: true, bestItemHrid: null, bestItemName: null }])
        );

        expect(networthInventoryDisplay.container.querySelector('#mwi-tokens-breakdown').textContent).toContain(
            'Labyrinth Token x30: no price'
        );
    });

    test('no tokens, no row; data from before tokens were listed renders without one', () => {
        networthInventoryDisplay.update(withTokens([]));
        expect(networthInventoryDisplay.container.querySelector('#mwi-tokens-toggle')).toBeNull();

        const legacy = withTokens([]);
        delete legacy.tokens;
        networthInventoryDisplay.update(legacy);
        expect(networthInventoryDisplay.container.querySelector('#mwi-tokens-toggle')).toBeNull();
    });

    test('the shrine row no longer says guild tokens have no value', () => {
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

        const title = networthInventoryDisplay.container
            .querySelector('#mwi-guild-shrines-toggle')
            .getAttribute('title');
        expect(title).not.toContain('carry no gold value');
        expect(title).toContain('tokens spent on shrines are not counted');
    });
});
