import { describe, test, expect } from 'vitest';
import {
    MAX_SERVER_TEXT_LENGTH,
    RANK_CATEGORIES,
    bestEntry,
    boardKey,
    boardTypeLabel,
    boardViewOf,
    isNarrowedBoard,
    buildNameIndex,
    categoryLabel,
    mergeBoards,
    nextBoardCategory,
    normalizeBoardType,
    normalizeName,
    parseLocalBoard,
    parseServerPayload,
    parseServerText,
    sanitizeBoards,
    tierForRank,
} from './rank-badge-data.js';

const NOW = Date.parse('2026-09-30T12:00:00Z');

describe('nextBoardCategory', () => {
    const held = (category, at, type = 'standard') => [`${type}|${category}`, { at, rows: [['A', 1]] }];

    test('walks forward to the first uncached category, wrapping, never the current one', () => {
        const boards = Object.fromEntries([held('total_level', 5), held('milking', 5)]);
        expect(nextBoardCategory(boards, 'standard', 'milking')).toBe('foraging');
        expect(nextBoardCategory({}, 'standard', null)).toBe('total_level');
        expect(nextBoardCategory(boards, 'standard', 'fame_points')).toBe('foraging');
        expect(nextBoardCategory(boards, 'ironcow', 'milking')).toBe('foraging');
    });

    test('with everything cached it picks the oldest, not the current', () => {
        const boards = Object.fromEntries(RANK_CATEGORIES.map((c, i) => held(c, 100 + i)));
        expect(nextBoardCategory(boards, 'standard', 'total_level')).toBe('milking');
        expect(nextBoardCategory(boards, 'standard', 'milking')).toBe('total_level');
    });
});

// Shape of the server payload as MWITools' own reader accepts it
// (schemaVersion 1, leaderboardType, categories → {receivedAt, rows}); assumed, not seen live
const serverPayload = (over = {}) => ({
    schemaVersion: 1,
    leaderboardType: 'standard',
    categories: {
        milking: {
            receivedAt: '2026-09-30T11:00:00Z',
            rows: [
                { characterName: 'Alice', rank: 1 },
                { characterName: 'Bob', rank: 30 },
            ],
        },
    },
    ...over,
});

// Shape of the game message as the XP tracker's fixtures have it: rows carry `name`, the tab filter
// rides as gameModeFilter; MWITools reads leaderboardType — both accepted
const localMessage = (over = {}) => ({
    leaderboardCategory: 'milking',
    gameModeFilter: 'standard',
    leaderboard: { rows: [{ name: 'Alice', rank: 2, value1: 100, value2: 5000 }] },
    ...over,
});

describe('tierForRank', () => {
    test.each([
        [1, 'rainbow'],
        [20, 'rainbow'],
        [21, 'gold'],
        [50, 'gold'],
        [51, 'silver'],
        [80, 'silver'],
        [81, 'bronze'],
        [100, 'bronze'],
        [101, null],
        [0, null],
        [2.5, null],
        ['3', null],
        [NaN, null],
    ])('rank %s is %s', (rank, tier) => {
        expect(tierForRank(rank)).toBe(tier);
    });
});

describe('names and labels', () => {
    test('names fold case and width', () => {
        expect(normalizeName('  ＡＬＩＣＥ ')).toBe('alice');
        expect(normalizeName(42)).toBe('');
    });

    test('board types', () => {
        expect(normalizeBoardType('legacy_ironcow')).toBe('ironcow');
        expect(normalizeBoardType('STANDARD')).toBe('standard');
        expect(normalizeBoardType('casual')).toBeNull();
    });

    test('category labels', () => {
        expect(categoryLabel('total_level')).toBe('Total Level');
        expect(categoryLabel('fame_points')).toBe('Fame');
    });
});

describe('parseLocalBoard', () => {
    test('reads a player board opened in the game', () => {
        const parsed = parseLocalBoard(localMessage(), NOW);
        expect(parsed.key).toBe('standard|milking');
        expect(parsed.board).toEqual({ at: NOW, source: 'local', rows: [['Alice', 2]] });
    });

    test.each(['labyrinth_points', 'collection_points', 'bestiary_points'])(
        'reads the %s board and badges a player',
        (c) => {
            expect(RANK_CATEGORIES).toContain(c);
            const parsed = parseLocalBoard(localMessage({ leaderboardCategory: c }), NOW);
            expect(parsed.key).toBe(`standard|${c}`);
            const index = buildNameIndex({ [parsed.key]: parsed.board });
            expect(bestEntry(index.get('alice'))).toMatchObject({ category: c, rank: 2 });
        }
    );

    test('every game player board has a badge category', () => {
        expect(RANK_CATEGORIES).toHaveLength(24);
    });

    test('takes the type from leaderboardType when present', () => {
        expect(parseLocalBoard(localMessage({ leaderboardType: 'ironcow', gameModeFilter: undefined }), NOW).key).toBe(
            'ironcow|milking'
        );
    });

    test('ignores guild boards, unknown categories, unattributable types and empty pages', () => {
        expect(parseLocalBoard(localMessage({ leaderboardCategory: 'guild' }), NOW)).toBeNull();
        expect(parseLocalBoard(localMessage({ gameModeFilter: undefined }), NOW)).toBeNull();
        expect(parseLocalBoard(localMessage({ leaderboard: { rows: [] } }), NOW)).toBeNull();
        expect(parseLocalBoard(null, NOW)).toBeNull();
    });

    test('ignores a filtered board so a partial top 100 cannot replace the global one', () => {
        expect(parseLocalBoard(localMessage({ guildTypeFilter: 'casual' }), NOW)).toBeNull();
        expect(parseLocalBoard(localMessage({ trialFilter: 'all' }), NOW)).not.toBeNull();
    });

    test('files a Steam board (its own leaderboardType) under its own slot only when asked', () => {
        const steam = localMessage({ leaderboardType: 'steam_standard', gameModeFilter: 'all' });
        expect(parseLocalBoard(steam, NOW, { includeSteam: true }).key).toBe('steam_standard|milking');
        expect(parseLocalBoard(steam, NOW)).toBeNull();
        const filtered = localMessage({ leaderboardType: 'steam_standard', guildTypeFilter: 'casual' });
        expect(parseLocalBoard(filtered, NOW, { includeSteam: true })).toBeNull();
        expect(boardViewOf(steam)).toBe('steam_standard');
        expect(boardViewOf(localMessage({ leaderboardType: 'steam_ironcow' }))).toBe('steam_ironcow');
        expect(boardViewOf(filtered)).toBeNull();
        expect(boardTypeLabel('steam_ironcow')).toBe('Ironcow (Steam)');
    });

    test('a full real leaderboard_updated message for a Steam board parses', () => {
        const message = {
            type: 'leaderboard_updated',
            leaderboardType: 'steam_standard',
            leaderboardCategory: 'total_level',
            guildTypeFilter: 'all',
            gameModeFilter: 'all',
            trialFilter: 'all',
            leaderboardRevision: 1,
            leaderboard: { rows: [{ name: 'Alice', rank: 1, value1: 1842, value2: 1 }] },
        };
        expect(isNarrowedBoard(message)).toBe(false);
        expect(boardViewOf(message)).toBe('steam_standard');
        expect(parseLocalBoard(message, NOW)).toBeNull();
        expect(parseLocalBoard(message, NOW, { includeSteam: true }).key).toBe('steam_standard|total_level');
    });

    test('Steam slots survive sanitizing and are indexed only when included', () => {
        const boards = { [boardKey('steam_standard', 'milking')]: { at: NOW, source: 'local', rows: [['A', 3]] } };
        expect(Object.keys(sanitizeBoards(boards))).toEqual(['steam_standard|milking']);
        expect(Object.keys(mergeBoards({}, boards, NOW))).toEqual(['steam_standard|milking']);
        expect(buildNameIndex(boards).size).toBe(0);
        expect(buildNameIndex(boards, { includeSteam: true }).get('a')[0].type).toBe('steam_standard');
    });

    test('drops out-of-range ranks and keeps the best rank of a duplicated name', () => {
        const rows = [
            { name: 'Alice', rank: 9 },
            { name: 'alice', rank: 4 },
            { name: 'Deep', rank: 101 },
            { name: 'Bad', rank: 'x' },
        ];
        expect(parseLocalBoard(localMessage({ leaderboard: { rows } }), NOW).board.rows).toEqual([['alice', 4]]);
    });
});

describe('parseServerPayload', () => {
    test('reads known categories and honors a plausible receivedAt', () => {
        const boards = parseServerPayload(serverPayload(), 'standard', NOW);
        expect(Object.keys(boards)).toEqual(['standard|milking']);
        expect(boards['standard|milking'].at).toBe(Date.parse('2026-09-30T11:00:00Z'));
        expect(boards['standard|milking'].source).toBe('server');
        expect(boards['standard|milking'].rows).toEqual([
            ['Alice', 1],
            ['Bob', 30],
        ]);
    });

    test('a future or garbage receivedAt becomes now', () => {
        const at = (receivedAt) =>
            parseServerPayload(
                serverPayload({ categories: { milking: { receivedAt, rows: [{ name: 'A', rank: 1 }] } } }),
                'standard',
                NOW
            )['standard|milking'].at;
        expect(at('2099-01-01T00:00:00Z')).toBe(NOW);
        expect(at('nonsense')).toBe(NOW);
        expect(at(undefined)).toBe(NOW);
    });

    test('rejects a wrong schema version or a different board pair than requested', () => {
        expect(parseServerPayload(serverPayload({ schemaVersion: 2 }), 'standard', NOW)).toEqual({});
        expect(parseServerPayload(serverPayload({ leaderboardType: 'ironcow' }), 'standard', NOW)).toEqual({});
    });

    test('malformed shapes yield nothing rather than throwing', () => {
        for (const bad of [null, 5, 'x', [], { schemaVersion: 1 }, serverPayload({ categories: 'x' })]) {
            expect(parseServerPayload(bad, 'standard', NOW)).toEqual({});
        }
        const odd = serverPayload({ categories: { milking: { rows: 'nope' }, foraging: null, __proto__x: {} } });
        expect(parseServerPayload(odd, 'standard', NOW)).toEqual({});
    });

    test('unknown categories in the payload are never read', () => {
        const boards = parseServerPayload(
            serverPayload({ categories: { hacking: { rows: [{ name: 'A', rank: 1 }] } } }),
            'standard',
            NOW
        );
        expect(boards).toEqual({});
    });

    test('oversized row lists and names are bounded', () => {
        const rows = Array.from({ length: 5000 }, (_, i) => ({ characterName: `P${i}`, rank: (i % 100) + 1 }));
        rows.push({ characterName: 'x'.repeat(200), rank: 1 });
        const board = parseServerPayload(serverPayload({ categories: { milking: { rows } } }), 'standard', NOW)[
            'standard|milking'
        ];
        expect(board.rows.length).toBeLessThanOrEqual(100);
        expect(board.rows.every(([name]) => name.length <= 64)).toBe(true);
    });
});

describe('parseServerText', () => {
    test('parses JSON text', () => {
        expect(Object.keys(parseServerText(JSON.stringify(serverPayload()), 'standard', NOW))).toHaveLength(1);
    });

    test('drops non-JSON, empty and oversized bodies unread', () => {
        expect(parseServerText('<html>', 'standard', NOW)).toEqual({});
        expect(parseServerText('', 'standard', NOW)).toEqual({});
        expect(parseServerText(undefined, 'standard', NOW)).toEqual({});
        expect(parseServerText('x'.repeat(MAX_SERVER_TEXT_LENGTH + 1), 'standard', NOW)).toEqual({});
    });
});

describe('mergeBoards', () => {
    const board = (at, source, ...rows) => ({ at, source, rows });

    test('the newer snapshot wins per board', () => {
        const merged = mergeBoards(
            { 'standard|milking': board(100, 'server', ['A', 1]), 'standard|foraging': board(100, 'server', ['A', 5]) },
            { 'standard|milking': board(200, 'local', ['B', 1]) }
        );
        expect(merged['standard|milking'].rows).toEqual([['B', 1]]);
        expect(merged['standard|foraging'].rows).toEqual([['A', 5]]);
    });

    test('an older local snapshot does not displace a newer server one', () => {
        const merged = mergeBoards(
            { 'standard|milking': board(300, 'server', ['S', 1]) },
            { 'standard|milking': board(200, 'local', ['L', 1]) }
        );
        expect(merged['standard|milking'].source).toBe('server');
    });

    test('on a tie the game rows win, whichever side they arrive on', () => {
        const server = { 'standard|milking': board(200, 'server', ['S', 1]) };
        const local = { 'standard|milking': board(200, 'local', ['L', 1]) };
        expect(mergeBoards(server, local)['standard|milking'].source).toBe('local');
        expect(mergeBoards(local, server)['standard|milking'].source).toBe('local');
    });

    test('does not modify its arguments and discards invalid boards', () => {
        const base = { 'standard|milking': board(100, 'server', ['A', 1]) };
        const copy = structuredClone(base);
        const merged = mergeBoards(base, { 'standard|hacking': board(1, 'local', ['X', 1]), junk: 1 });
        expect(base).toEqual(copy);
        expect(Object.keys(merged)).toEqual(['standard|milking']);
    });

    test('a synced board stamped in the future is capped, and a later genuine capture replaces it', () => {
        const future = { 'standard|milking': board(NOW + 3 * 86_400_000, 'server', ['Stale', 1]) };
        expect(sanitizeBoards(future, NOW)['standard|milking'].at).toBe(NOW);
        const held = mergeBoards({}, future, NOW);
        expect(held['standard|milking'].at).toBe(NOW);
        const merged = mergeBoards(held, { 'standard|milking': board(NOW + 1000, 'local', ['Fresh', 1]) }, NOW + 1000);
        expect(merged['standard|milking'].rows).toEqual([['Fresh', 1]]);
    });

    test('sanitizeBoards survives garbage', () => {
        expect(sanitizeBoards(null)).toEqual({});
        expect(sanitizeBoards({ 'standard|milking': { at: 'x', rows: [] } })).toEqual({});
        expect(
            sanitizeBoards({ 'standard|milking': { at: 5, rows: [['A', 1], 'bad', [7, 3], ['B', 500]] } }, NOW)
        ).toEqual({
            'standard|milking': { at: 5, source: 'local', rows: [['A', 1]] },
        });
    });
});

describe('name index and best rank', () => {
    const boards = {
        [boardKey('standard', 'milking')]: {
            at: 10,
            source: 'local',
            rows: [
                ['Alice', 12],
                ['Bob', 3],
            ],
        },
        [boardKey('standard', 'total_level')]: { at: 20, source: 'server', rows: [['Alice', 12]] },
        [boardKey('ironcow', 'milking')]: { at: 30, source: 'server', rows: [['Alice', 12]] },
        [boardKey('standard', 'foraging')]: { at: 40, source: 'server', rows: [['alice', 4]] },
    };

    test('the best rank leads, and one player is one index entry however cased', () => {
        const index = buildNameIndex(boards);
        expect(bestEntry(index.get('alice'))).toMatchObject({ category: 'foraging', rank: 4 });
        expect(bestEntry(index.get('bob'))).toMatchObject({ category: 'milking', rank: 3 });
        expect(bestEntry(index.get('nobody'))).toBeNull();
    });

    test('a tied rank falls to category order, then to the standard board', () => {
        const index = buildNameIndex({ ...boards, [boardKey('standard', 'foraging')]: undefined });
        expect(index.get('alice').map((e) => `${e.type}|${e.category}`)).toEqual([
            'standard|total_level',
            'standard|milking',
            'ironcow|milking',
        ]);
    });
});
