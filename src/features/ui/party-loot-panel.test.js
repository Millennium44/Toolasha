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

const game = vi.hoisted(() => ({ data: null, sessions: [] }));

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
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
// Mocked outright rather than through importOriginal: the real module is
// exercised by its own tests, and pulling it in here recurses through the mock
// factory while the graph is still being built
vi.mock('../combat-stats/combat-session-history.js', () => ({
    loadSessions: async () => game.sessions,
    combineSessions: (list) => (list.length ? { ...list[0], combined: true, sessionCount: list.length } : null),
    describeSession: (session) => `run ${session.key}`,
}));

const { partyLootPanel } = await import('./party-loot-panel.js');

const CHEST = { itemHrid: '/items/enchanted_chest', itemName: 'Enchanted Chest', count: 2, totalValue: 7_400_000 };
const ODDITY = { itemHrid: '/items/nothing', itemName: 'Unpriced Thing', count: 1, totalValue: 0 };

beforeEach(() => {
    game.sessions = [];
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

/**
 * Let the archive read land and draw again.
 *
 * The panel fires its storage read off `draw` rather than awaiting it, so the
 * picker is always one frame behind the archive. Twice, because the read started
 * by the *previous* draw is what the first render consumes.
 */
const settle = async () => {
    for (let i = 0; i < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        partyLootPanel.render();
    }
};

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

describe('the top bar', () => {
    const archived = (key, start) => ({
        key,
        combatStartTime: start,
        durationSeconds: 3600,
        players: [{ name: 'Millennium44', isCurrentPlayer: true, income: 1_000_000, lootList: [CHEST] }],
    });

    const values = () => [...partyLootPanel.panel.querySelectorAll('option')].map((option) => option.value);

    const choose = (value) => {
        const picker = partyLootPanel.panel.querySelector('select');
        picker.value = value;
        picker.dispatchEvent(new Event('change'));
    };

    test('the live run is what it opens on', () => {
        partyLootPanel.show();

        expect(partyLootPanel.panel.querySelector('select')?.value).toBe('live');
    });

    test('an archived run is offered once it has been read back', async () => {
        game.sessions = [archived('a|1', '2026-08-02T22:00:00Z')];
        partyLootPanel.show();
        await settle();

        expect(values()).toContain('a|1');
    });

    test('a combined view appears only when there is more than one run', async () => {
        game.sessions = [archived('a|1', '2026-08-02T22:00:00Z')];
        partyLootPanel.show();
        await settle();
        expect(values()).not.toContain('combined');

        game.sessions = [archived('a|1', '2026-08-02T22:00:00Z'), archived('b|2', '2026-08-02T20:00:00Z')];
        await settle();
        expect(values()).toContain('combined');
    });

    test('choosing an archived run shows that run rather than the live one', async () => {
        game.sessions = [archived('a|1', '2026-08-02T22:00:00Z')];
        partyLootPanel.show();
        await settle();

        choose('a|1');

        // The archived run is solo, so the live run's second character is gone
        expect(text()).not.toContain('Briggsy99');
        expect(text()).toContain('Millennium44');
    });

    test('a chosen run that has since fallen off the list falls back to live', async () => {
        game.sessions = [archived('a|1', '2026-08-02T22:00:00Z')];
        partyLootPanel.show();
        await settle();
        choose('a|1');

        // Twenty runs later it has been pushed out. The panel must not sit on an
        // empty body pointing at a run that no longer exists.
        game.sessions = [];
        await settle();

        expect(partyLootPanel.panel.querySelector('select').value).toBe('live');
        expect(text()).toContain('Briggsy99');
    });
});
