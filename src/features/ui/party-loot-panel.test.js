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
    calculatePlayerStats: (player, duration) => ({
        name: player.name,
        income: { bid: player.income ?? 0, ask: player.income ?? 0 },
        consumableCosts: { bid: 1000, ask: 1000 },
        keyCosts: { bid: 500, ask: 500 },
        dailyProfit: { bid: (player.income ?? 0) * 10, ask: 0 },
        lootList: player.lootList || [],
        // Not part of the real return shape — carried only so a test can see
        // what duration the panel actually asked for
        _duration: duration,
    }),
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
// Mocked outright rather than through importOriginal: the real module is
// exercised by its own tests, and pulling it in here recurses through the mock
// factory while the graph is still being built
vi.mock('../combat-stats/combat-session-history.js', () => ({
    loadSessions: async () => game.sessions,
    // `game.combinedResult` lets one test hand back a specific combined
    // snapshot (an old `combatStartTime`, per-player `durationSeconds`) to
    // check what the panel does with it, without exercising the real merge
    combineSessions: (list) =>
        game.combinedResult ?? (list.length ? { ...list[0], combined: true, sessionCount: list.length } : null),
    describeSession: (session) => `run ${session.key}`,
}));

const { partyLootPanel, buildSessionHistoryRows, SESSION_HISTORY_COLUMNS, buildSummaryText, _partyRuns } =
    await import('./party-loot-panel.js');

const CHEST = { itemHrid: '/items/enchanted_chest', itemName: 'Enchanted Chest', count: 2, totalValue: 7_400_000 };
const ODDITY = { itemHrid: '/items/nothing', itemName: 'Unpriced Thing', count: 1, totalValue: 0 };

beforeEach(() => {
    game.sessions = [];
    game.combinedResult = undefined;
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

    test('a coin-sized count is compacted rather than overflowing its column', () => {
        game.data.players[1].lootList = [
            { itemHrid: '/items/coin', itemName: 'Coin', count: 2_581_181, totalValue: 2_581_181 },
        ];
        partyLootPanel.show();

        expect(text()).toContain('× 2.6M');
        expect(text()).not.toContain('2,581,181');
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

    test('a combined view times each player by their own sessions, not the wall-clock span of every run', async () => {
        // Two archived runs a day apart. B only fought in the second one.
        // combineSessions correctly hands back each player's own summed
        // duration (600s for A across both runs, 300s for B in just the one)
        // — the bug was the panel discarding that and re-timing everyone off
        // "now minus the oldest run's combatStartTime" instead, which for an
        // archive spanning a day is a wildly different, wildly wrong number.
        game.sessions = [archived('a|1', '2026-08-02T22:00:00Z'), archived('b|2', '2026-08-01T22:00:00Z')];
        game.combinedResult = {
            combined: true,
            sessionCount: 2,
            combatStartTime: '2026-08-01T22:00:00Z', // the older of the two runs
            durationSeconds: 900,
            players: [
                { name: 'A', isCurrentPlayer: true, income: 100, lootList: [], durationSeconds: 600 },
                { name: 'B', isCurrentPlayer: false, income: 50, lootList: [], durationSeconds: 300 },
            ],
        };
        partyLootPanel.show();
        await settle();

        choose('combined');

        const [a, b] = _partyRuns();
        expect(a._duration).toBe(600);
        expect(b._duration).toBe(300);
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

    test('the export button appears only once there is a history to write', async () => {
        const button = () =>
            [...partyLootPanel.panel.querySelectorAll('button')].find((el) => el.textContent === 'Export CSV');

        partyLootPanel.show();
        // The archive cache outlives the panel, so let the empty read land first
        await settle();
        expect(button()).toBeUndefined();

        game.sessions = [archived('a|1', '2026-08-02T22:00:00Z')];
        await settle();
        expect(button()).toBeTruthy();
    });

    test('the copy button appears whenever there is a party on screen, archive or not', async () => {
        const button = () => [...partyLootPanel.panel.querySelectorAll('button')].find((el) => el.textContent === '⧉');

        partyLootPanel.show();
        await settle();
        // No archived sessions at all — still a live party, so still a button
        expect(button()).toBeTruthy();
    });

    test('copy puts the on-screen view on the clipboard, not the whole archive', async () => {
        const written = [];
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation((value) => {
            written.push(value);
            return Promise.resolve();
        });

        partyLootPanel.show();
        await settle();
        const button = [...partyLootPanel.panel.querySelectorAll('button')].find((el) => el.textContent === '⧉');
        button.click();

        expect(written[0]).toContain('Live Session');
        expect(written[0]).toContain('Briggsy99');
        expect(written[0]).toContain('Enchanted Chest');
    });

    test('the history appears on the first open without waiting for a refresh', async () => {
        game.sessions = [archived('a|1', '2026-08-02T22:00:00Z')];
        partyLootPanel.show();

        // No manual re-render: the archive read itself must trigger the redraw
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(values()).toContain('a|1');
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

describe('the session-history CSV rows', () => {
    // The same arithmetic the cards draw, injected rather than imported so the
    // expected figures are on the page
    const statsFor = (player) => ({
        name: player.name,
        income: { bid: player.income, ask: player.income },
        consumableCosts: { bid: 1000 },
        keyCosts: { bid: 500 },
        dailyProfit: { bid: player.income * 10 },
    });

    test('no archive is no rows', () => {
        expect(buildSessionHistoryRows([], statsFor)).toEqual([]);
        expect(buildSessionHistoryRows(null, statsFor)).toEqual([]);
    });

    test('one row per session: start, duration, zone, party size, and each player’s banked figure', () => {
        const sessionList = [
            {
                key: 'Briggsy99,Millennium44|2026-08-02T22:00:00Z',
                combatStartTime: '2026-08-02T22:00:00Z',
                durationSeconds: 3600,
                actionHrid: '/actions/combat/rainbow_bay',
                players: [
                    { name: 'Briggsy99', income: 8_000_000 },
                    { name: 'Millennium44', income: 3_000_000 },
                ],
            },
        ];

        expect(buildSessionHistoryRows(sessionList, statsFor)).toEqual([
            {
                start: '2026-08-02T22:00:00.000Z',
                durationSeconds: 3600,
                zone: 'rainbow bay',
                zoneHrid: '/actions/combat/rainbow_bay',
                partySize: 2,
                players: 'Briggsy99, Millennium44',
                bankedTotal: 8_000_000 - 1500 + (3_000_000 - 1500),
                perPlayerBanked: 'Briggsy99: 7998500; Millennium44: 2998500',
                perPlayerDaily: 'Briggsy99: 80000000; Millennium44: 30000000',
            },
        ]);
    });

    test('a snapshot without players is skipped rather than exported as an empty run', () => {
        expect(buildSessionHistoryRows([{ combatStartTime: '2026-08-02T22:00:00Z', players: [] }], statsFor)).toEqual(
            []
        );
    });

    test('every column names a field the rows carry', () => {
        const [row] = buildSessionHistoryRows(
            [{ combatStartTime: '2026-08-02T22:00:00Z', durationSeconds: 60, players: [{ name: 'A', income: 1 }] }],
            statsFor
        );
        for (const column of SESSION_HISTORY_COLUMNS) {
            expect(row).toHaveProperty(column.key);
        }
    });
});

describe('the plain-text summary', () => {
    const stats = (overrides) => ({
        name: 'Briggsy99',
        income: { bid: 8_000_000 },
        consumableCosts: { bid: 1000 },
        keyCosts: { bid: 500 },
        dailyProfit: { bid: 80_000_000 },
        lootList: [CHEST],
        ...overrides,
    });

    test('an empty party is an empty string, not a header with nothing under it', () => {
        expect(buildSummaryText([], 'Live Session')).toBe('');
        expect(buildSummaryText(null, 'Live Session')).toBe('');
    });

    test('carries the label, the banked figure, the rate and every drop', () => {
        const out = buildSummaryText([stats()], 'Live Session');
        expect(out).toContain('Party Loot — Live Session');
        expect(out).toContain('Briggsy99: 7,998,500 coins (80,000,000/day)');
        expect(out).toContain('2 × Enchanted Chest — 7,400,000');
    });

    test('a player with nothing dropped yet says so rather than showing an empty list', () => {
        const out = buildSummaryText([stats({ lootList: [] })], 'Live Session');
        expect(out).toContain('Nothing dropped yet.');
    });
});
