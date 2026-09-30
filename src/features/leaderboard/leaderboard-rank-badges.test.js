/** @vitest-environment happy-dom */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    mode: 'off',
    saved: {},
    wsHandlers: {},
    settingWatchers: [],
    classHandlers: [],
    response: { status: 200, text: '' },
    requests: [],
}));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.wsHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.wsHandlers[event] === handler) delete game.wsHandlers[event];
        },
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: () => game.mode,
        onSettingChange: (key, callback) => {
            game.settingWatchers.push(callback);
            return () => {
                game.settingWatchers = game.settingWatchers.filter((cb) => cb !== callback);
            };
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, store, fallback) => game.saved[key] ?? fallback,
        set: async (key, value) => {
            game.saved[key] = structuredClone(value);
            return true;
        },
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, classes, callback) => {
            game.classHandlers.push(callback);
            return () => {
                game.classHandlers = game.classHandlers.filter((cb) => cb !== callback);
            };
        },
    },
}));
vi.mock('../sync/gist-client.js', () => ({
    httpRequest: async (options) => {
        game.requests.push(options);
        return game.response;
    },
}));
vi.mock('../../utils/asset-manifest.js', () => ({
    default: { getSpriteUrl: async (key) => `/static/${key}.svg` },
}));

const { leaderboardRankBadges, describeEntries, RANK_SERVER_INTERVAL_MS } =
    await import('./leaderboard-rank-badges.js');

const serverBody = (leaderboardType, rows, receivedAt = new Date().toISOString()) =>
    JSON.stringify({
        schemaVersion: 1,
        leaderboardType,
        categories: { milking: { receivedAt, rows } },
    });

const nameEl = (name, parent = document.body) => {
    const el = document.createElement('span');
    el.className = 'CharacterName_name__abc';
    el.setAttribute('data-name', name);
    el.textContent = name;
    parent.appendChild(el);
    return el;
};

const badges = () => [...document.querySelectorAll('[data-toolasha-rank-badge]')];
const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe('leaderboard rank badges', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
        game.mode = 'off';
        game.saved = {};
        game.wsHandlers = {};
        game.settingWatchers = [];
        game.classHandlers = [];
        game.requests = [];
        game.response = { status: 200, text: serverBody('standard', [{ characterName: 'Alice', rank: 3 }]) };
        document.body.innerHTML = '';
        document.head.innerHTML = '';
    });

    afterEach(() => {
        leaderboardRankBadges.cleanup();
        vi.useRealTimers();
    });

    test('Off registers nothing, fetches nothing and draws nothing', async () => {
        nameEl('Alice');
        await leaderboardRankBadges.initialize();
        await vi.advanceTimersByTimeAsync(RANK_SERVER_INTERVAL_MS * 3);

        expect(game.wsHandlers.leaderboard_updated).toBeUndefined();
        expect(game.classHandlers).toHaveLength(0);
        expect(game.requests).toHaveLength(0);
        expect(badges()).toHaveLength(0);
        expect(document.getElementById('toolasha-rank-badge-style')).toBeNull();
        // Only the setting watch exists, so switching the select can start it live
        expect(game.settingWatchers).toHaveLength(1);
    });

    test('Local only draws a badge from a board the player opens, and never fetches', async () => {
        game.mode = 'local';
        await leaderboardRankBadges.initialize();
        const el = nameEl('Alice');

        game.wsHandlers.leaderboard_updated({
            leaderboardCategory: 'milking',
            gameModeFilter: 'standard',
            leaderboard: { rows: [{ name: 'Alice', rank: 7 }] },
        });
        await flush();

        expect(game.requests).toHaveLength(0);
        const badge = el.nextElementSibling;
        expect(badge.hasAttribute('data-toolasha-rank-badge')).toBe(true);
        expect(badge.getAttribute('data-toolasha-rank-badge')).toBe('rainbow');
        expect(badge.textContent).toBe('7');
        expect(badge.title).toContain('Milking · Standard rank 7 (as of just now)');
        expect(badge.querySelector('use').getAttribute('href')).toBe('/static/skills.svg#milking');
        expect(game.saved.rankBoards['standard|milking'].rows).toEqual([['Alice', 7]]);
    });

    test('a name that appears later is decorated by the observer callback, and unranked names get nothing', async () => {
        game.mode = 'local';
        game.saved.rankBoards = { 'standard|milking': { at: Date.now(), source: 'local', rows: [['Alice', 55]] } };
        await leaderboardRankBadges.initialize();

        const ranked = nameEl('alice');
        const other = nameEl('Nobody');
        for (const handler of game.classHandlers) {
            handler(ranked);
            handler(other);
        }

        expect(ranked.nextElementSibling.getAttribute('data-toolasha-rank-badge')).toBe('silver');
        expect(other.nextElementSibling).toBeNull();
    });

    test('names drawn as plain text, with no data-name, are badged once and stay idempotent', async () => {
        game.mode = 'local';
        game.saved.rankBoards = { 'standard|milking': { at: Date.now(), source: 'local', rows: [['Alice', 2]] } };
        await leaderboardRankBadges.initialize();
        // The profile modal and a restored chat sender, as the fixtures draw them
        document.body.innerHTML =
            '<div class="CharacterName_characterName__1amXp"><div class="CharacterName_name__1amXo"><span>Alice</span></div></div>' +
            '<span class="ChatMessage_name__1"><div class="CharacterName_characterName__2"><div class="CharacterName_name__1amXp"><span>Alice:</span></div></div></span>';
        leaderboardRankBadges.decorateAll(false);
        leaderboardRankBadges.decorateAll(false);
        leaderboardRankBadges.decorateAll(true);
        leaderboardRankBadges.decorateAll(false);

        expect(badges()).toHaveLength(2);
        for (const el of document.querySelectorAll('[class*="CharacterName_name"]')) {
            expect(el.nextElementSibling.hasAttribute('data-toolasha-rank-badge')).toBe(true);
            expect(el.nextElementSibling.nextElementSibling).toBeNull();
        }
    });

    test('names inside the leaderboard panel and the header are left alone', async () => {
        game.mode = 'local';
        game.saved.rankBoards = { 'standard|milking': { at: Date.now(), source: 'local', rows: [['Alice', 2]] } };
        await leaderboardRankBadges.initialize();
        const panel = document.createElement('div');
        panel.className = 'LeaderboardPanel_row__x';
        document.body.appendChild(panel);
        nameEl('Alice', panel);
        await flush();

        expect(badges()).toHaveLength(0);
    });

    test('Server fetches both board types on enable and every 15 minutes, GET only, and stops on disable', async () => {
        game.mode = 'server';
        await leaderboardRankBadges.initialize();
        await flush();

        expect(game.requests.map((r) => r.url)).toEqual([
            'https://mwi-guild.43.167.210.211.sslip.io/api/v1/leaderboards?leaderboardType=standard',
            'https://mwi-guild.43.167.210.211.sslip.io/api/v1/leaderboards?leaderboardType=ironcow',
        ]);
        expect(game.requests.every((r) => r.method === 'GET' && !r.body && !r.headers)).toBe(true);

        await vi.advanceTimersByTimeAsync(RANK_SERVER_INTERVAL_MS);
        expect(game.requests).toHaveLength(4);

        // Turning the setting off tears the timer down
        game.mode = 'off';
        for (const cb of game.settingWatchers) cb('off');
        await flush();
        await vi.advanceTimersByTimeAsync(RANK_SERVER_INTERVAL_MS * 4);
        expect(game.requests).toHaveLength(4);
        expect(game.wsHandlers.leaderboard_updated).toBeUndefined();
    });

    test('cleanup stops the server timer', async () => {
        game.mode = 'server';
        await leaderboardRankBadges.initialize();
        await flush();
        const before = game.requests.length;

        leaderboardRankBadges.cleanup();
        await vi.advanceTimersByTimeAsync(RANK_SERVER_INTERVAL_MS * 4);

        expect(game.requests).toHaveLength(before);
        expect(game.settingWatchers).toHaveLength(0);
    });

    test('server rows draw badges; a failed fetch falls back to the local rows already held', async () => {
        game.mode = 'server';
        game.response = { status: 500, text: '' };
        game.saved.rankBoards = { 'standard|milking': { at: Date.now(), source: 'local', rows: [['Alice', 90]] } };
        const el = nameEl('Alice');
        await leaderboardRankBadges.initialize();
        await flush();

        expect(el.nextElementSibling.getAttribute('data-toolasha-rank-badge')).toBe('bronze');

        game.response = {
            status: 200,
            text: serverBody('standard', [{ characterName: 'Alice', rank: 1 }], '2026-09-30T12:10:00Z'),
        };
        await vi.advanceTimersByTimeAsync(RANK_SERVER_INTERVAL_MS);
        await flush();

        // Fetched now, so newer than the stored local board: the server rows win
        expect(el.nextElementSibling.getAttribute('data-toolasha-rank-badge')).toBe('rainbow');
        expect(el.nextElementSibling.hasAttribute('data-top-five')).toBe(true);
    });

    test('server strings are never parsed as markup', async () => {
        game.mode = 'server';
        game.response = {
            status: 200,
            text: serverBody('standard', [{ characterName: '<img src=x onerror=alert(1)>', rank: 4 }]),
        };
        const el = nameEl('<img src=x onerror=alert(1)>');
        await leaderboardRankBadges.initialize();
        await flush();

        expect(document.querySelector('img')).toBeNull();
        expect(el.nextElementSibling.textContent).toBe('4');
    });

    test('a malformed body draws nothing and does not throw', async () => {
        game.mode = 'server';
        game.response = { status: 200, text: '{"schemaVersion":1,"categories":' };
        nameEl('Alice');
        await leaderboardRankBadges.initialize();
        await flush();

        expect(badges()).toHaveLength(0);
    });
});

describe('describeEntries', () => {
    test('lists at most five entries with their ages', () => {
        const now = Date.parse('2026-09-30T12:00:00Z');
        const entries = Array.from({ length: 7 }, (_, i) => ({
            type: i % 2 ? 'ironcow' : 'standard',
            category: 'milking',
            rank: i + 1,
            at: now - 90 * 60000,
        }));
        const lines = describeEntries(entries, now).split('\n');
        expect(lines).toHaveLength(5);
        expect(lines[1]).toBe('Milking · Ironcow rank 2 (as of 1h 30m ago)');
    });
});
