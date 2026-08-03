import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ actions: [], actionDetail: null, characterId: 'me' }));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false, COLOR_TEXT_PRIMARY: '#fff' } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.actions,
        getCurrentCharacterId: () => game.characterId,
        getActionDetails: () => game.actionDetail,
        getInitClientData: () => ({ combatMonsterDetailMap: {} }),
    },
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 1 }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, clearAll: () => {} }),
}));

const { default: combatDropLuck, formatOrdinal, describeLuck } = await import('./combat-drop-luck.js');

describe('formatOrdinal', () => {
    test('gets the ordinary suffixes right', () => {
        expect(formatOrdinal(0.21)).toBe('21st');
        expect(formatOrdinal(0.22)).toBe('22nd');
        expect(formatOrdinal(0.23)).toBe('23rd');
        expect(formatOrdinal(0.24)).toBe('24th');
    });

    test('gets the teens right', () => {
        // 11th, not 11st — the one case a bare last-digit rule gets wrong
        expect(formatOrdinal(0.11)).toBe('11th');
        expect(formatOrdinal(0.12)).toBe('12th');
        expect(formatOrdinal(0.13)).toBe('13th');
    });

    test('never reads as a certainty in either direction', () => {
        // "100th percentile" claims no session could have done better, and
        // "0th" claims none could have done worse. Neither is ever true.
        expect(formatOrdinal(1)).toBe('99th');
        expect(formatOrdinal(0)).toBe('1st');
        expect(formatOrdinal(0.999)).toBe('99th');
    });
});

describe('describeLuck', () => {
    test('says how many runs beat it, not the percentile twice', () => {
        expect(describeLuck(0.73).text).toBe('73rd percentile — 27 runs in 100 beat it');
    });

    test('sorts sessions into lucky, unlucky and unremarkable', () => {
        expect(describeLuck(0.9).tone).toBe('lucky');
        expect(describeLuck(0.05).tone).toBe('unlucky');
        expect(describeLuck(0.5).tone).toBe('normal');
    });

    test('the boundaries count as notable rather than normal', () => {
        expect(describeLuck(0.75).tone).toBe('lucky');
        expect(describeLuck(0.25).tone).toBe('unlucky');
    });
});

describe('watching a dungeon pay out', () => {
    /**
     * A `new_battle` for a two-person party holding this many chests each.
     *
     * @param {number} battleId - Which battle
     * @param {Array<number>} counts - Chests, mine first
     * @returns {Object}
     */
    const battle = (battleId, counts) => ({
        battleId,
        players: counts.map((count, index) => ({
            character: { id: index === 0 ? 'me' : 'them', name: index === 0 ? 'Mine' : 'Theirs' },
            combatDetails: { combatStats: { combatDropQuantity: 0.5 } },
            totalLootMap: {
                1: { itemHrid: '/items/chimerical_chest', count },
                2: { itemHrid: '/items/coin', count: 999 },
            },
        })),
    });

    beforeEach(() => {
        game.actions = [{ actionHrid: '/actions/combat/chimerical_den', difficultyTier: 0 }];
        game.actionDetail = {
            combatZoneInfo: {
                isDungeon: true,
                dungeonInfo: { rewardDropTable: [{ itemHrid: '/items/chimerical_chest', dropRate: 1 }] },
            },
        };
        combatDropLuck.chests = null;
        combatDropLuck.context = null;
        // The live percentile is throttled and this test is not about it
        combatDropLuck.liveAt = Date.now();
    });

    test('the chests somebody walked in with are not a windfall', () => {
        combatDropLuck._rememberContext(battle(1, [40, 0]));

        expect(combatDropLuck.dungeonChestLuck().players[0].luck).toBeNull();
    });

    test('each rise is one completion, and the party splits the five', () => {
        // Five chests over two players at +50% quantity is a mean of 3.75:
        // three guaranteed and a 75% chance of a fourth
        combatDropLuck._rememberContext(battle(1, [0, 0]));
        combatDropLuck._rememberContext(battle(2, [4, 3]));
        combatDropLuck._rememberContext(battle(3, [7, 6]));

        const [mine, theirs] = combatDropLuck.dungeonChestLuck().players;

        expect(mine.mean).toBeCloseTo(3.75, 6);
        expect(mine.luck.completions).toBe(2);
        expect(mine.luck.chests).toBe(7);
        expect(mine.isCurrentPlayer).toBe(true);
        expect(theirs.luck.chests).toBe(6);
        expect(theirs.isCurrentPlayer).toBe(false);
    });

    test('a run of four chests every time reads as lucky, three every time as not', () => {
        combatDropLuck._rememberContext(battle(1, [0, 0]));
        for (let i = 0; i < 8; i++) combatDropLuck._rememberContext(battle(i + 2, [4 * (i + 1), 3 * (i + 1)]));

        const [mine, theirs] = combatDropLuck.dungeonChestLuck().players;

        expect(mine.luck.percentile).toBe(1);
        expect(theirs.luck.percentile).toBeLessThan(0.01);
    });

    test('leaving the dungeon stops the reading rather than freezing it', () => {
        combatDropLuck._rememberContext(battle(1, [0, 0]));
        combatDropLuck._rememberContext(battle(2, [4, 3]));

        game.actionDetail = { combatZoneInfo: { isDungeon: false } };
        combatDropLuck._rememberContext(battle(1, [0, 0]));

        expect(combatDropLuck.dungeonChestLuck()).toBeNull();
    });

    test('starting the dungeon again starts the count again', () => {
        // The loot map goes back to nothing, which would otherwise read as
        // everybody opening their chests at once
        combatDropLuck._rememberContext(battle(9, [0, 0]));
        combatDropLuck._rememberContext(battle(10, [4, 3]));
        combatDropLuck._rememberContext(battle(1, [0, 0]));
        combatDropLuck._rememberContext(battle(2, [4, 3]));

        expect(combatDropLuck.dungeonChestLuck().players[0].luck.completions).toBe(1);
    });
});
