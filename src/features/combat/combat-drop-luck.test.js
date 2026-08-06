import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ actions: [], actionDetail: null, characterId: 'me', runs: [] }));

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
vi.mock('./dungeon-tracker.js', () => ({ default: { onUpdate: () => {}, offUpdate: () => {} } }));
vi.mock('./dungeon-tracker-storage.js', () => ({
    default: {
        getDungeonInfo: () => ({ name: 'Chimerical Den' }),
        getAllRuns: async () => game.runs,
    },
}));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, clearAll: () => {} }),
}));

const {
    default: combatDropLuck,
    formatOrdinal,
    describeLuck,
} = await import('./combat-drop-luck.js');

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
    const battle = (battleId, counts, levels = [100, 100]) => ({
        battleId,
        players: counts.map((count, index) => ({
            character: { id: index === 0 ? 'me' : 'them', name: index === 0 ? 'Mine' : 'Theirs' },
            combatDetails: { combatLevel: levels[index], combatStats: { combatDropQuantity: 0.5 } },
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
        combatDropLuck.keys = { counts: {}, spent: {}, gained: {}, samples: {} };
        game.runs = [];
        // The live percentile is throttled and this test is not about it
        combatDropLuck.liveAt = Date.now();
    });

    test('chests already there are shown, and not yet placed', () => {
        // They are real — session loot, not inventory — but nothing yet says how
        // many completions produced them, and a total with no denominator cannot
        // be a percentile
        combatDropLuck._rememberContext(battle(1, [40, 0]));

        const [mine] = combatDropLuck.dungeonChestLuck().players;
        expect(mine.chests).toBe(40);
        expect(mine.luck).toBeNull();
    });

    test('completions from before the reload are recovered from the tracker history', async () => {
        // The chests come back on their own; the runs behind them are counted
        // from what the tracker has been writing down all along
        game.runs = [
            { dungeonName: 'Chimerical Den', timestamp: '2026-08-03T01:10:00Z' },
            { dungeonName: 'Chimerical Den', timestamp: '2026-08-03T01:20:00Z' },
            // Before this session started, so not this session's
            { dungeonName: 'Chimerical Den', timestamp: '2026-08-03T00:10:00Z' },
            // A different dungeon entirely
            { dungeonName: 'Pirate Cove', timestamp: '2026-08-03T01:30:00Z' },
        ];

        combatDropLuck._rememberContext({ ...battle(40, [7, 6]), combatStartTime: '2026-08-03T01:00:00Z' });

        // The restore is fired off the message handler rather than awaited there,
        // so let it land before reading
        await new Promise((resolve) => setTimeout(resolve, 0));
        const luck = combatDropLuck.dungeonChestLuck();

        expect(luck.restored).toBe(2);
        expect(luck.counted).toBe('tracker');
        expect(luck.players[0].luck.completions).toBe(2);
        expect(luck.players[0].luck.chests).toBe(7);
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

    test('the tracker outranks the chest count, and can see a run that paid nothing', () => {
        // The case the chest count cannot reach: a completion that gave somebody
        // no chest produces no rise, so inference sees no run at all
        combatDropLuck._rememberContext(battle(1, [0, 0]));
        combatDropLuck._rememberContext(battle(2, [4, 0]));
        combatDropLuck._onDungeonCompleted({ keyCountsMap: {} });

        const [mine, theirs] = combatDropLuck.dungeonChestLuck().players;

        expect(combatDropLuck.dungeonChestLuck().counted).toBe('tracker');
        expect(theirs.luck.completions).toBe(1);
        expect(theirs.luck.chests).toBe(0);
        expect(mine.observed).toBe(4);
        expect(theirs.observed).toBe(0);
    });

    test('without the tracker it falls back to watching the chests', () => {
        combatDropLuck._rememberContext(battle(1, [0, 0]));
        combatDropLuck._rememberContext(battle(2, [4, 3]));

        expect(combatDropLuck.dungeonChestLuck().counted).toBe('chests');
        expect(combatDropLuck.dungeonChestLuck().players[0].luck.completions).toBe(1);
    });

    test('a completion samples what the party spent, and only when it falls', () => {
        combatDropLuck._rememberContext(battle(1, [0, 0]));
        combatDropLuck._onDungeonCompleted({ keyCountsMap: { Theirs: 50 } });
        combatDropLuck._onDungeonCompleted({ keyCountsMap: { Theirs: 47 } });
        combatDropLuck._onDungeonCompleted({ keyCountsMap: { Theirs: 90 } });

        expect(combatDropLuck.keys.samples.Theirs).toMatchObject({ spent: 3, runs: 1, unmeasurable: 1 });
    });

    test('a character far below the party is owed less, and the model says so', () => {
        // The gap goes into the expectation. Two players at +50% quantity split
        // five chests: a mean of 3.75 each, and at a 90% penalty 0.375 — which
        // the game realises as usually nothing and occasionally one.
        combatDropLuck._rememberContext(battle(1, [0, 0], [200, 100]));
        combatDropLuck._rememberContext(battle(2, [4, 1], [200, 100]));

        const [mine, theirs] = combatDropLuck.dungeonChestLuck().players;

        expect(mine.levelGap).toBe(0);
        expect(mine.mean).toBeCloseTo(3.75, 6);
        expect(theirs.levelGap).toBe(-0.9);
        expect(theirs.mean).toBeCloseTo(0.375, 6);
        // One chest against an owed 0.375 is a good run, not the catastrophe a
        // full share would have called it
        expect(theirs.luck.percentile).toBeGreaterThan(0.5);
    });

    test('the seen rate is kept beside the modelled one, so a wrong debuff shows', () => {
        // The debuff's size is borrowed from the monster-drop formula and nothing
        // has confirmed a dungeon uses it. If it is wrong these two diverge.
        combatDropLuck._rememberContext(battle(1, [0, 0], [200, 100]));
        combatDropLuck._rememberContext(battle(2, [4, 1], [200, 100]));

        const theirs = combatDropLuck.dungeonChestLuck().players[1];

        expect(theirs.observed).toBe(1);
        expect(theirs.mean).toBeCloseTo(0.375, 6);
    });

    test('an unknown level is not reported as no gap', () => {
        combatDropLuck._rememberContext(battle(1, [0, 0], [undefined, undefined]));

        expect(combatDropLuck.dungeonChestLuck().players[0].levelGap).toBeNull();
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

    test('a refresh mid-session keeps the chests, because the server re-sends them', () => {
        // `totalLootMap` is the session's loot and arrives whole on the first
        // message after a reload. Treating that first sighting as a baseline is
        // what used to throw the run away.
        const session = '2026-08-03T01:00:00Z';
        combatDropLuck._rememberContext({ ...battle(40, [63, 50]), combatStartTime: session });

        const [mine] = combatDropLuck.dungeonChestLuck().players;
        expect(mine.chests).toBe(63);
    });

    test('and a new session is still a new session', () => {
        combatDropLuck._rememberContext({ ...battle(40, [63, 50]), combatStartTime: '2026-08-03T01:00:00Z' });
        combatDropLuck._rememberContext({ ...battle(1, [0, 0]), combatStartTime: '2026-08-03T02:00:00Z' });

        expect(combatDropLuck.dungeonChestLuck().players[0].chests).toBe(0);
    });

    test('the same session across a reload is not a new one', () => {
        const session = '2026-08-03T01:00:00Z';
        combatDropLuck._rememberContext({ ...battle(40, [63, 50]), combatStartTime: session });
        // A reload restarts the battle numbering it saw, but not the session
        combatDropLuck._rememberContext({ ...battle(1, [65, 50]), combatStartTime: session });

        const [mine] = combatDropLuck.dungeonChestLuck().players;
        expect(mine.chests).toBe(65);
        expect(mine.luck.completions).toBe(1);
    });
});
