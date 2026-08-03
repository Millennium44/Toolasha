/** @vitest-environment happy-dom
 *
 * The Party Loot panel, built rather than reasoned about.
 *
 * The arithmetic belongs to `calculatePlayerStats` and is tested where it lives.
 * What building this catches is the shape of what it is handed: cost figures
 * that are `{ask, bid}` objects rather than numbers, a player with no drops, a
 * drop the market has no price for, and the state the panel spends most of its
 * life in — nothing measured yet.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ data: null }));

vi.mock('../../core/config.js', () => ({
    default: { Z_FLOATING_PANEL: 1100, getSetting: () => true, getSettingValue: () => 'full' },
}));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => game.data },
}));
vi.mock('../combat-stats/combat-stats-calculator.js', () => ({
    calculatePlayerStats: (player) => ({
        name: player.name,
        income: { bid: player.income ?? 0, ask: player.income ?? 0 },
        consumableCosts: { bid: 1000, ask: 1000 },
        keyCosts: { bid: 500, ask: 500 },
        dailyProfit: { bid: (player.income ?? 0) * 10, ask: 0 },
        lootList: player.lootList || [],
    }),
}));
vi.mock('../../utils/panel-geometry.js', () => ({ restoreGeometry: () => {}, saveGeometry: () => {} }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));

const { partyLootPanel } = await import('./party-loot-panel.js');

const CHEST = { itemHrid: '/items/enchanted_chest', itemName: 'Enchanted Chest', count: 2, totalValue: 7_400_000 };
const ODDITY = { itemHrid: '/items/nothing', itemName: 'Unpriced Thing', count: 1, totalValue: 0 };

beforeEach(() => {
    game.data = {
        combatStartTime: '2026-08-03T01:00:00Z',
        players: [
            { name: 'Briggsy99', isCurrentPlayer: false, income: 8_300_000, lootList: [CHEST] },
            { name: 'Millennium44', isCurrentPlayer: true, income: 3_700_000, lootList: [CHEST, ODDITY] },
        ],
    };
});

afterEach(() => partyLootPanel.hide());

const text = () => partyLootPanel.panel.textContent;
const FAILED = 'could not be drawn';

describe('the panel renders', () => {
    test('a card per character, and none of them fails', () => {
        partyLootPanel.show();

        expect(text()).toContain('Millennium44');
        expect(text()).toContain('Briggsy99');
        expect(text()).toContain('Enchanted Chest');
        expect(text()).not.toContain(FAILED);
    });

    test('yours is first whatever order the party arrived in', () => {
        // The figure you look for should always be on the same line
        partyLootPanel.show();

        expect(text().indexOf('Millennium44')).toBeLessThan(text().indexOf('Briggsy99'));
    });

    test('the costs are objects, and subtracting them naively gives NaN', () => {
        // Which is exactly how the Total Profit tile went wrong once already
        partyLootPanel.show();

        expect(text()).not.toContain('NaN');
    });

    test('the party total comes before the characters', () => {
        partyLootPanel.show();

        expect(text()).toContain('Party of 2');
        expect(text().indexOf('Party of 2')).toBeLessThan(text().indexOf('Briggsy99'));
    });

    test('solo there is no party total, because it would be the card below it', () => {
        game.data.players = [game.data.players[1]];
        partyLootPanel.show();

        expect(text()).not.toContain('Party of');
        expect(text()).toContain('Millennium44');
    });

    test('an unpriced drop is shown as unpriced rather than as worthless', () => {
        // Zero is a claim about what it is worth; the market has simply not said
        partyLootPanel.show();

        expect(text()).toContain('Unpriced Thing');
        expect(text()).toContain('—');
    });

    test('a character who looted nothing says so', () => {
        game.data.players[0].lootList = [];
        partyLootPanel.show();

        expect(text()).toContain('Nothing dropped yet');
        expect(text()).not.toContain(FAILED);
    });

    test('nothing measured yet says why rather than being blank', () => {
        game.data = null;
        partyLootPanel.show();

        expect(text()).toContain('No run measured yet');
        expect(text()).not.toContain(FAILED);
    });
});
