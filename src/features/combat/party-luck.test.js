/**
 * Party luck.
 *
 * The claim worth pinning is that each player is measured against **their own**
 * drop gear. A version that split one expectation evenly across the party would
 * produce plausible numbers and report the player with the drop-rate build as
 * permanently lucky — which is the exact failure the single-player model already
 * has a comment about.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ players: [], actionDetail: null, monsters: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: () => game.actionDetail,
        getInitClientData: () => ({ combatMonsterDetailMap: game.monsters }),
    },
}));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => ({ players: game.players }) },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => ({ '/items/a': 100 })[hrid] ?? null,
}));

const { partyLuck } = await import('./party-luck.js');

const CONTEXT = { actionHrid: '/actions/zone', difficultyTier: 0, battles: 100 };

/** One monster, always spawning, dropping one item worth 100 at one in ten */
beforeEach(() => {
    game.monsters = {
        '/monsters/grunt': { dropTable: [{ itemHrid: '/items/a', dropRate: 0.1, minCount: 1, maxCount: 1 }] },
    };
    game.actionDetail = {
        combatZoneInfo: {
            isDungeon: false,
            fightInfo: {
                randomSpawnInfo: {
                    spawns: [{ combatMonsterHrid: '/monsters/grunt', rate: 1, strength: 1 }],
                    maxSpawnCount: 1,
                    maxTotalStrength: 1,
                },
                bossSpawns: [],
            },
        },
    };
    game.players = [
        {
            name: 'Geared',
            isCurrentPlayer: true,
            loot: { a: { itemHrid: '/items/a', count: 10 } },
            combatStats: { combatDropRate: 1, combatRareFind: 0, combatDropQuantity: 0 },
        },
        {
            name: 'Bare',
            isCurrentPlayer: false,
            loot: { a: { itemHrid: '/items/a', count: 5 } },
            combatStats: { combatDropRate: 0, combatRareFind: 0, combatDropQuantity: 0 },
        },
    ];
});

describe('partyLuck', () => {
    test('each player is measured against their own drop gear', () => {
        // +100% drop rate is owed twice as much, so the same haul is worse luck.
        // Splitting one expectation evenly would report the geared player as
        // permanently lucky, which is the failure this exists to avoid.
        const { players } = partyLuck(CONTEXT);
        const geared = players.find((player) => player.name === 'Geared');
        const bare = players.find((player) => player.name === 'Bare');

        expect(geared.expectedValue).toBeCloseTo(bare.expectedValue * 2, 6);
    });

    test('the same haul reads differently against different expectations', () => {
        game.players[1].loot = { a: { itemHrid: '/items/a', count: 10 } };

        const { players } = partyLuck(CONTEXT);
        const geared = players.find((player) => player.name === 'Geared');
        const bare = players.find((player) => player.name === 'Bare');

        expect(geared.percent).toBeLessThan(bare.percent);
    });

    test('the total is the party against the party, not an average of percentages', () => {
        // An average weights somebody who looted one item the same as somebody
        // who looted a hundred
        const { players, total } = partyLuck(CONTEXT);

        const actual = players.reduce((sum, player) => sum + player.actualValue, 0);
        const expected = players.reduce((sum, player) => sum + player.expectedValue, 0);
        expect(total.actualValue).toBeCloseTo(actual, 6);
        expect(total.percent).toBeCloseTo((actual / expected - 1) * 100, 6);
    });

    test('party size splits the loot, so two players are each owed half', () => {
        const solo = partyLuck(CONTEXT);
        game.players = [game.players[1]];
        const alone = partyLuck(CONTEXT);

        const inParty = solo.players.find((player) => player.name === 'Bare');
        expect(alone.players[0].expectedValue).toBeCloseTo(inParty.expectedValue * 2, 6);
    });

    test('items are listed biggest haul first, with what each was owed', () => {
        const [player] = partyLuck(CONTEXT).players;
        const item = player.items.find((entry) => entry.itemHrid === '/items/a');

        expect(item.count).toBe(10);
        expect(item.expected).toBeGreaterThan(0);
        expect(item.percent).toBeCloseTo((item.count / item.expected - 1) * 100, 6);
    });

    test('no context means nothing measured rather than a guess', () => {
        expect(partyLuck(null).players).toEqual([]);
        expect(partyLuck({ ...CONTEXT, battles: 0 }).players).toEqual([]);
    });

    test('a zone the model cannot cover is nothing rather than a crash', () => {
        game.actionDetail = { combatZoneInfo: { isDungeon: true } };
        expect(partyLuck(CONTEXT)).toEqual({ players: [], total: null, battles: 100 });
    });
});
