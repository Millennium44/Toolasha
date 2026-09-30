/** @vitest-environment happy-dom */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    mode: 'off',
    steam: false,
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
        getSettingValue: (key) => (key === 'leaderboardRankBadgesSteam' ? game.steam : game.mode),
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
        game.steam = false;
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
        expect(game.settingWatchers).toHaveLength(2);
    });

    test('a reused name element that switches player gets the new player badge, or none', async () => {
        game.mode = 'local';
        await leaderboardRankBadges.initialize();
        const el = nameEl('Alice');
        game.wsHandlers.leaderboard_updated({
            leaderboardCategory: 'milking',
            gameModeFilter: 'standard',
            leaderboard: {
                rows: [
                    { name: 'Alice', rank: 7 },
                    { name: 'Bob', rank: 40 },
                ],
            },
        });
        await flush();
        expect(el.nextElementSibling.textContent).toContain('7');

        el.setAttribute('data-name', 'Bob');
        el.textContent = 'Bob';
        await flush();
        await vi.advanceTimersByTimeAsync(10);
        expect(badges()).toHaveLength(1);
        expect(el.nextElementSibling.textContent).toContain('40');

        el.setAttribute('data-name', 'Nobody');
        el.textContent = 'Nobody';
        await flush();
        await vi.advanceTimersByTimeAsync(10);
        expect(badges()).toHaveLength(0);
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

    test('the tooltip age is recomputed on hover, not frozen at decoration', async () => {
        game.mode = 'local';
        await leaderboardRankBadges.initialize();
        const el = nameEl('Alice');
        game.wsHandlers.leaderboard_updated({
            leaderboardCategory: 'milking',
            gameModeFilter: 'standard',
            leaderboard: { rows: [{ name: 'Alice', rank: 7 }] },
        });
        await flush();
        const badge = el.nextElementSibling;
        expect(badge.title).toContain('as of just now');

        vi.setSystemTime(new Date('2026-09-30T14:05:00Z'));
        badge.dispatchEvent(new Event('mouseenter'));

        expect(badge.title).not.toContain('just now');
        expect(badge.title).toContain('2h');
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
        expect(game.requests.every((r) => r.anonymous === true)).toBe(true);

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

describe('next board button', () => {
    const LABELS = ['Total Level', 'Milking', 'Foraging', 'Woodcutting'];

    const buildPanel = (labels = LABELS) => {
        const root = document.createElement('div');
        root.className = 'LeaderboardPanel_leaderboardPanel__x';
        const clicks = [];
        const strip = document.createElement('div');
        strip.setAttribute('role', 'tablist');
        for (const label of labels) {
            const tab = document.createElement('button');
            tab.setAttribute('role', 'tab');
            tab.textContent = label;
            tab.addEventListener('click', () => clicks.push(label));
            strip.appendChild(tab);
        }
        const content = document.createElement('div');
        content.className = 'LeaderboardPanel_content__y';
        root.append(strip, content);
        document.body.appendChild(root);
        return { root, content, clicks };
    };
    const bar = () => document.querySelector('[data-toolasha-rank-cycle]');
    const board = (category, rank = 1) => ({
        leaderboardCategory: category,
        gameModeFilter: 'standard',
        leaderboard: { rows: [{ name: 'Alice', rank }] },
    });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
        game.steam = false;
        game.saved = {};
        game.wsHandlers = {};
        game.settingWatchers = [];
        game.classHandlers = [];
        document.body.innerHTML = '';
        document.head.innerHTML = '';
    });

    afterEach(() => {
        leaderboardRankBadges.cleanup();
        vi.useRealTimers();
    });

    test('appears only in Local only mode, inside the leaderboard panel', async () => {
        game.mode = 'server';
        const { content } = buildPanel();
        await leaderboardRankBadges.initialize();
        expect(bar()).toBeNull();

        game.mode = 'local';
        await leaderboardRankBadges.restart();
        expect(bar()).not.toBeNull();
        expect(content.previousElementSibling).toBe(bar());
        expect(bar().textContent).toContain('Next board ▸ Total Level');
        expect(bar().textContent).toContain('0/21 boards cached');

        const stray = document.createElement('div');
        stray.className = 'LeaderboardPanel_content__z';
        const guild = document.createElement('div');
        guild.className = 'GuildPanel_x';
        guild.appendChild(stray);
        document.body.appendChild(guild);
        for (const handler of game.classHandlers) handler(stray);
        expect(document.querySelectorAll('[data-toolasha-rank-cycle]')).toHaveLength(1);
    });

    test('is hidden while a guild board is open and returns with a player board', async () => {
        game.mode = 'local';
        buildPanel();
        await leaderboardRankBadges.initialize();
        expect(bar().style.display).toBe('flex');

        game.wsHandlers.leaderboard_updated({
            leaderboardCategory: 'guild_points',
            leaderboard: { rows: [{ name: 'Some Guild', rank: 1 }] },
        });
        await flush();
        expect(bar().style.display).toBe('none');

        game.wsHandlers.leaderboard_updated(board('total_level'));
        await flush();
        expect(bar().style.display).toBe('flex');
    });

    test('shows on a Steam tab, counting Steam boards opened, and stays hidden on Guilds', async () => {
        game.mode = 'local';
        buildPanel();
        await leaderboardRankBadges.initialize();

        game.wsHandlers.leaderboard_updated({ ...board('total_level'), leaderboardType: 'steam_standard' });
        await flush();
        expect(bar().style.display).toBe('flex');
        expect(bar().textContent).toContain('1/21 Steam boards opened');
        expect(bar().textContent).toContain('Next board ▸ Milking');

        game.wsHandlers.leaderboard_updated({
            leaderboardCategory: 'guild_points',
            leaderboardType: 'steam_standard',
            leaderboard: { rows: [{ name: 'Some Guild', rank: 1 }] },
        });
        await flush();
        expect(bar().style.display).toBe('none');

        game.wsHandlers.leaderboard_updated(board('total_level'));
        await flush();
        expect(bar().style.display).toBe('flex');
        expect(bar().textContent).toContain('boards cached');
    });

    test('is hidden on a view filtered', async () => {
        game.mode = 'local';
        buildPanel();
        await leaderboardRankBadges.initialize();
        game.wsHandlers.leaderboard_updated({ ...board('total_level'), guildTypeFilter: 'casual' });
        await flush();
        expect(bar().style.display).toBe('none');
    });

    test('Next on a Steam tab follows the Steam view opened map, not the global cache', async () => {
        game.mode = 'local';
        const { clicks } = buildPanel();
        await leaderboardRankBadges.initialize();
        const button = bar().querySelector('button');
        // Global boards known for total level and milking; the Steam view has opened only total level
        game.wsHandlers.leaderboard_updated(board('total_level'));
        game.wsHandlers.leaderboard_updated(board('milking'));
        game.wsHandlers.leaderboard_updated({ ...board('total_level'), leaderboardType: 'steam_standard' });
        await flush();
        expect(button.textContent).toContain('Milking');

        button.click();
        expect(clicks).toEqual(['Milking']);
        game.wsHandlers.leaderboard_updated({ ...board('milking'), leaderboardType: 'steam_standard' });
        await flush();
        expect(bar().textContent).toContain('2/21 Steam boards opened');
        expect(button.textContent).toContain('Foraging');

        // Ironcow (Steam) is its own view
        game.wsHandlers.leaderboard_updated({
            ...board('total_level'),
            leaderboardType: 'steam_ironcow',
        });
        await flush();
        expect(bar().textContent).toContain('1/21 Steam boards opened');
    });

    test('insertion is idempotent across re-renders', async () => {
        game.mode = 'local';
        const { content } = buildPanel();
        await leaderboardRankBadges.initialize();
        for (const handler of game.classHandlers) handler(content);
        for (const handler of game.classHandlers) handler(content);
        expect(document.querySelectorAll('[data-toolasha-rank-cycle]')).toHaveLength(1);
    });

    test('one press makes exactly one click on the matching tab, and repeated presses advance', async () => {
        game.mode = 'local';
        const { clicks } = buildPanel();
        await leaderboardRankBadges.initialize();
        const button = bar().querySelector('button');

        button.click();
        expect(clicks).toEqual(['Total Level']);

        // The game answers with the board that was opened, then the next press moves on
        game.wsHandlers.leaderboard_updated(board('total_level'));
        await flush();
        expect(bar().textContent).toContain('1/21 boards cached');
        expect(button.textContent).toContain('Milking');
        button.click();
        expect(clicks).toEqual(['Total Level', 'Milking']);
        button.click();
        expect(clicks).toEqual(['Total Level', 'Milking', 'Foraging']);
    });

    test('finds a tab by its icon when the label is not English', async () => {
        game.mode = 'local';
        const { root, clicks } = buildPanel([]);
        const strip = root.querySelector('[role="tablist"]');
        for (const [label, symbol] of [
            ['总等级', 'leaderboard'],
            ['挤奶', 'milking'],
        ]) {
            const tab = document.createElement('button');
            tab.setAttribute('role', 'tab');
            tab.innerHTML = `<svg><use href="/static/media/skills_sprite.abc.svg#${symbol}"></use></svg>${label}`;
            tab.addEventListener('click', () => clicks.push(symbol));
            strip.appendChild(tab);
        }
        await leaderboardRankBadges.initialize();
        const button = bar().querySelector('button');
        button.click();
        game.wsHandlers.leaderboard_updated(board('total_level'));
        await flush();
        button.click();
        expect(clicks).toEqual(['leaderboard', 'milking']);
    });

    test('a re-render that replaces the panel content keeps the bar working against the new panel', async () => {
        game.mode = 'local';
        const { root, content, clicks } = buildPanel();
        await leaderboardRankBadges.initialize();
        const fresh = document.createElement('div');
        fresh.className = 'LeaderboardPanel_content__y';
        content.replaceWith(fresh);
        for (const handler of game.classHandlers) handler(fresh);
        expect(document.querySelectorAll('[data-toolasha-rank-cycle]')).toHaveLength(1);
        expect(root.contains(bar())).toBe(true);

        bar().querySelector('button').click();
        expect(clicks).toEqual(['Total Level']);
        expect(bar().textContent).not.toContain('Could not find');
    });

    describe('category tab panels', () => {
        // Mirrors the live tree: each category tab mounts its own TabPanel + content inside one panels container
        const buildTabs = () => {
            const outer = document.createElement('div');
            outer.className = 'LeaderboardPanel_tabsComponentContainer__a';
            const tabsComponent = document.createElement('div');
            tabsComponent.className = 'TabsComponent_tabsComponent__b';
            const clicks = [];
            const strip = document.createElement('div');
            strip.setAttribute('role', 'tablist');
            for (const label of LABELS) {
                const tab = document.createElement('button');
                tab.setAttribute('role', 'tab');
                tab.className = 'MuiTab-root';
                tab.textContent = label;
                tab.addEventListener('click', () => clicks.push(label));
                strip.appendChild(tab);
            }
            const panels = document.createElement('div');
            panels.className = 'TabsComponent_tabPanelsContainer__c';
            tabsComponent.append(strip, panels);
            outer.appendChild(tabsComponent);
            document.body.appendChild(outer);
            const mount = () => {
                const panel = document.createElement('div');
                panel.className = 'TabPanel_tabPanel__d';
                const content = document.createElement('div');
                content.className = 'LeaderboardPanel_content__y';
                panel.appendChild(content);
                panels.appendChild(panel);
                return { panel, content };
            };
            return { panels, mount, clicks };
        };
        const notify = (content) => {
            for (const handler of game.classHandlers) handler(content);
        };

        test('the single bar sits above the panels, so an unmounted panel takes nothing with it', async () => {
            game.mode = 'local';
            const { panels, mount, clicks } = buildTabs();
            const first = mount();
            await leaderboardRankBadges.initialize();
            expect(document.querySelectorAll('[data-toolasha-rank-cycle]')).toHaveLength(1);
            expect(panels.firstElementChild).toBe(bar());

            first.panel.remove();
            const second = mount();
            notify(second.content);
            expect(document.querySelectorAll('[data-toolasha-rank-cycle]')).toHaveLength(1);
            expect(panels.firstElementChild).toBe(bar());
            expect(bar().nextElementSibling).toBe(second.panel);

            bar().querySelector('button').click();
            expect(clicks).toEqual(['Total Level']);
        });

        test('with the old panel kept mounted but hidden there is still exactly one bar', async () => {
            game.mode = 'local';
            const { panels, mount } = buildTabs();
            const first = mount();
            await leaderboardRankBadges.initialize();
            first.panel.hidden = true;
            const second = mount();
            notify(second.content);
            notify(first.content);
            expect(document.querySelectorAll('[data-toolasha-rank-cycle]')).toHaveLength(1);
            expect(panels.firstElementChild).toBe(bar());
            expect(first.panel.hidden).toBe(true);
            expect(bar().nextElementSibling).toBe(first.panel);
        });

        test('a bar left beside an old panel content is replaced by the one above the panels', async () => {
            game.mode = 'local';
            const { panels, mount } = buildTabs();
            const first = mount();
            const stale = document.createElement('div');
            stale.setAttribute('data-toolasha-rank-cycle', '');
            first.content.before(stale);
            await leaderboardRankBadges.initialize();
            expect(document.querySelectorAll('[data-toolasha-rank-cycle]')).toHaveLength(1);
            expect(panels.firstElementChild).toBe(bar());
        });
    });

    test('a missing tab leaves a note and does not throw or click anything', async () => {
        game.mode = 'local';
        const { clicks } = buildPanel(['Milking']);
        await leaderboardRankBadges.initialize();
        expect(() => bar().querySelector('button').click()).not.toThrow();
        expect(clicks).toEqual([]);
        expect(bar().textContent).toContain('Could not find the Total Level tab');
    });

    test('cleanup and a mode change take the bar down', async () => {
        game.mode = 'local';
        buildPanel();
        await leaderboardRankBadges.initialize();
        expect(bar()).not.toBeNull();

        game.mode = 'server';
        await leaderboardRankBadges.restart();
        expect(bar()).toBeNull();

        game.mode = 'local';
        await leaderboardRankBadges.restart();
        expect(bar()).not.toBeNull();
        leaderboardRankBadges.cleanup();
        expect(bar()).toBeNull();
    });
});

describe('Steam boards in badges', () => {
    const steamBoard = (rows, extra = {}) => ({
        leaderboardCategory: 'milking',
        gameModeFilter: 'standard',
        leaderboardType: 'steam_standard',
        leaderboard: { rows },
        ...extra,
    });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
        game.mode = 'local';
        game.steam = false;
        game.saved = {};
        game.wsHandlers = {};
        game.settingWatchers = [];
        game.classHandlers = [];
        document.body.innerHTML = '';
        document.head.innerHTML = '';
    });

    afterEach(() => {
        leaderboardRankBadges.cleanup();
        vi.useRealTimers();
    });

    test('with the option off a Steam board message changes no badge and stores nothing', async () => {
        nameEl('Alice');
        await leaderboardRankBadges.initialize();
        game.wsHandlers.leaderboard_updated(steamBoard([{ name: 'Alice', rank: 2 }]));
        await flush();
        expect(badges()).toHaveLength(0);
        expect(game.saved.rankBoards).toBeUndefined();
    });

    test('with it on the Steam rank is labelled Steam and leaves the global slot alone', async () => {
        game.steam = true;
        nameEl('Alice');
        await leaderboardRankBadges.initialize();
        game.wsHandlers.leaderboard_updated({
            leaderboardCategory: 'milking',
            gameModeFilter: 'standard',
            leaderboard: { rows: [{ name: 'Alice', rank: 40 }] },
        });
        game.wsHandlers.leaderboard_updated(steamBoard([{ name: 'Alice', rank: 2 }]));
        await flush();

        expect(badges()[0].textContent).toContain('2');
        expect(badges()[0].title).toContain('Standard (Steam) rank 2');
        expect(badges()[0].title).toContain('Standard rank 40');
        expect(game.saved.rankBoards['standard|milking'].rows).toEqual([['Alice', 40]]);
        expect(game.saved.rankBoards['steam_standard|milking'].rows).toEqual([['Alice', 2]]);
    });

    test('a filtered view stays out even with the option on', async () => {
        game.steam = true;
        nameEl('Alice');
        await leaderboardRankBadges.initialize();
        game.wsHandlers.leaderboard_updated(steamBoard([{ name: 'Alice', rank: 2 }], { guildTypeFilter: 'casual' }));
        await flush();
        expect(badges()).toHaveLength(0);
    });

    test('toggling the setting re-renders: stored Steam ranks hide when off and return when on', async () => {
        game.steam = true;
        nameEl('Alice');
        await leaderboardRankBadges.initialize();
        game.wsHandlers.leaderboard_updated(steamBoard([{ name: 'Alice', rank: 2 }]));
        await flush();
        expect(badges()).toHaveLength(1);

        game.steam = false;
        for (const callback of game.settingWatchers) callback();
        await vi.advanceTimersByTimeAsync(0);
        expect(badges()).toHaveLength(0);
        expect(game.saved.rankBoards['steam_standard|milking']).toBeDefined();

        game.steam = true;
        for (const callback of game.settingWatchers) callback();
        await vi.advanceTimersByTimeAsync(0);
        expect(badges()).toHaveLength(1);
    });

    test('a settings restart keeps the Steam view that is on screen', async () => {
        game.steam = true;
        await leaderboardRankBadges.initialize();
        game.wsHandlers.leaderboard_updated(steamBoard([{ name: 'Alice', rank: 2 }]));
        await flush();
        expect(leaderboardRankBadges.boardType).toBe('steam_standard');
        expect(leaderboardRankBadges.boardCategory).toBe('milking');

        game.steam = false;
        for (const callback of game.settingWatchers) callback();
        await vi.advanceTimersByTimeAsync(0);
        expect(leaderboardRankBadges.boardType).toBe('steam_standard');
        expect(leaderboardRankBadges.boardCategory).toBe('milking');
    });
});
