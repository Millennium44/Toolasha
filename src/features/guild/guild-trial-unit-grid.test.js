/**
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildGuildMember } from '../../__fixtures__/wire/guild-members.js';

const game = vi.hoisted(() => ({ settings: {}, listeners: [], members: [], week: null, metaListeners: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : fallback),
        onSettingChange: (key, fn) => {
            const entry = { key, fn };
            game.listeners.push(entry);
            return () => {
                game.listeners = game.listeners.filter((l) => l !== entry);
            };
        },
    },
}));

vi.mock('./guild-xp-tracker.js', () => ({
    guildXPTracker: {
        getMemberList: () => game.members,
        getCurrentWeekStartAt: () => game.week,
        onMetaChanged: (fn) => {
            game.metaListeners.push(fn);
            return () => {
                game.metaListeners = game.metaListeners.filter((l) => l !== fn);
            };
        },
    },
}));

const {
    default: feature,
    SETTING,
    GRID_MARK,
    PLACED_MARK,
    STYLE_ID,
    computeLayout,
    sortTiles,
} = await import('./guild-trial-unit-grid.js');

const WEEK = '2026-11-02T00:00:00Z';
const member = (name, role, overrides = {}) =>
    buildGuildMember({
        name,
        signedUpCombatTrialHrid: role === null ? '' : '/guild_combat/swarm',
        signedUpCombatRoleHrid: role || '',
        signupWeekStartAt: WEEK,
        ...overrides,
    });

/** A trial area: the card, then columns of up to three tiles in the given (game) order */
const area = (areaClass, cardClass, names, id = 'a') => {
    const cols = [];
    for (let i = 0; i < names.length; i += 3) {
        const tiles = names
            .slice(i, i + 3)
            .map(
                (n) =>
                    `<div class="MiniUnit_miniUnit__f" data-n="${n}"><div class="MiniUnit_name__g">${n}</div>` +
                    `<div class="MiniUnit_hp__h">100</div></div>`
            )
            .join('');
        cols.push(`<div class="MiniUnitGrid_miniUnitColumn__e">${tiles}</div>`);
    }
    return `<div class="${areaClass}" id="${id}"><div class="MiniUnitGrid_miniUnitGrid__b">
      <div class="${cardClass}"></div>${cols.join('')}</div></div>`;
};
const COMBAT = (names, id) => area('BattlePanel_guildPartyArea__a', 'CombatUnit_combatUnit__c', names, id);
const SKILLING = (names, id) =>
    area('SkillingInstancePanel_playerArea__a', 'SkillingInstancePanel_skillingUnit__c', names, id);
const NORMAL = (names) => area('BattlePanel_playersArea__z', 'CombatUnit_combatUnit__c', names, 'n');

/** happy-dom has no layout: give elements widths */
const width = (el, w) => {
    el.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: w, width: w, height: 0 });
};
/** card 130, tiles 47, area and grid `areaW` wide */
const measure = (areaW = 600) => {
    for (const grid of document.querySelectorAll('[class*="MiniUnitGrid_miniUnitGrid"]')) width(grid, areaW);
    for (const el of document.querySelectorAll('[class*="Area"], [class*="playerArea"]')) width(el, areaW);
    for (const card of document.querySelectorAll('[class*="CombatUnit_combat"], [class*="skillingUnit"]')) {
        width(card, 130);
    }
    for (const tile of document.querySelectorAll('[class*="MiniUnit_miniUnit"]')) width(tile, 47);
};
const flush = () => new Promise((r) => requestAnimationFrame(() => r()));
const tick = async () => {
    await Promise.resolve();
    await flush();
};
const tile = (n, root = document) => root.querySelector(`[data-n="${n}"]`);
const at = (n, root) => [tile(n, root).style.gridRow, tile(n, root).style.gridColumn];
/** Visual order: tiles sorted by row-major position beside the card (rows 1-3 column-major) */
const columnOf = (n, root) => Number(tile(n, root).style.gridColumn.split(' / ')[0]);
const visual = (root = document) =>
    [...root.querySelectorAll('[class*="MiniUnit_miniUnit"]')]
        .map((t) => ({ n: t.dataset.n, row: Number(t.style.gridRow), col: columnOf(t.dataset.n, root) }))
        .sort(
            (a, b) =>
                (a.row > 3) - (b.row > 3) ||
                (a.row > 3 ? a.row - b.row || a.col - b.col : a.col - b.col || a.row - b.row)
        )
        .map((t) => t.n);

describe('computeLayout', () => {
    test('stacks of three beside the card, tight to it, then rows under the card from the left edge', () => {
        // 130 + 4 + 47 = 181 one stack; two stacks need 232; area 240 fits two
        const l = computeLayout({ cardW: 130, tileW: 47, areaW: 240, count: 9 });
        expect(l.beside).toBe(6);
        const edges = [0];
        for (const w of l.columns) edges.push(Math.round((edges.at(-1) + w) * 100) / 100);
        const span = (c) => {
            const [a, b] = c.split(' / ').map(Number);
            return [edges[a - 1], edges[b - 1]];
        };
        expect(span(l.card.column)).toEqual([0, 130]);
        expect(l.card.row).toBe('1 / span 3');
        expect(l.tiles.slice(0, 6).map((t) => [t.row, span(t.column)])).toEqual([
            [1, [134, 181]],
            [2, [134, 181]],
            [3, [134, 181]],
            [1, [185, 232]],
            [2, [185, 232]],
            [3, [185, 232]],
        ]);
        // (240 + 4) / 51 = 4 a row under the card; 3 left over → one row, left to right from 0
        expect(l.tiles.slice(6).map((t) => [t.row, span(t.column)])).toEqual([
            [4, [0, 47]],
            [4, [51, 98]],
            [4, [102, 149]],
        ]);
        // Never wider than the area
        expect(edges.at(-1)).toBeLessThanOrEqual(240);
    });

    test('a second overflow row starts back at the left edge', () => {
        const l = computeLayout({ cardW: 130, tileW: 47, areaW: 181, count: 7 });
        // one stack beside; under: (181 + 4) / 51 = 3 a row
        expect(l.beside).toBe(3);
        expect(l.tiles.slice(3).map((t) => t.row)).toEqual([4, 4, 4, 5]);
        expect(l.tiles[6].column).toBe(l.tiles[3].column);
    });

    test('too narrow for any stack: every tile under the card, at least one a row', () => {
        const l = computeLayout({ cardW: 130, tileW: 47, areaW: 140, count: 2 });
        expect(l.beside).toBe(0);
        expect(l.tiles.map((t) => t.row)).toEqual([4, 4]);
        const narrow = computeLayout({ cardW: 130, tileW: 47, areaW: 30, count: 2 });
        expect(narrow.tiles.map((t) => t.row)).toEqual([4, 5]);
    });

    test('all fit beside: no rows under the card', () => {
        const l = computeLayout({ cardW: 130, tileW: 47, areaW: 900, count: 5 });
        expect(l.beside).toBe(5);
        expect(l.tiles.every((t) => t.row <= 3)).toBe(true);
    });
});

describe('sortTiles', () => {
    const t = (names) => names.map((name, index) => ({ name, index }));
    test('role groups tank, support, damage dealer, then no role; names locale-aware and case-insensitive', () => {
        const roleOf = new Map([
            ['zed', 'tank'],
            ['Amy', 'damage_dealer'],
            ['bob', 'support'],
            ['Al', 'tank'],
            ['ben', 'damage_dealer'],
        ]);
        const out = sortTiles(t(['Amy', 'nobody', 'ben', 'zed', 'bob', 'Al', 'Ann']), { roles: true, roleOf });
        expect(out.map((x) => x.name)).toEqual(['Al', 'zed', 'bob', 'Amy', 'ben', 'Ann', 'nobody']);
    });
    test('without roles: name only; a nameless tile last in DOM order', () => {
        const roleOf = new Map([['zed', 'tank']]);
        const out = sortTiles(t(['zed', '', 'amy', '', 'Bob']), { roles: false, roleOf });
        expect(out.map((x) => `${x.name}${x.index}`)).toEqual(['amy2', 'Bob4', 'zed0', '1', '3']);
    });
});

describe('guild trial unit grid', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        document.getElementById(STYLE_ID)?.remove();
        game.settings = {};
        game.listeners = [];
        game.metaListeners = [];
        game.week = WEEK;
        game.members = [
            member('Tess', 'tank'),
            member('sam', 'support'),
            member('Dora', 'damage_dealer'),
            member('dan', 'damage_dealer'),
            member('Ned', ''),
        ];
    });
    afterEach(() => feature.cleanup());

    test('combat trial: tiles grouped by role then name, card first, columns flattened by the stylesheet', async () => {
        document.body.innerHTML = COMBAT(['Ned', 'Dora', 'sam', 'dan', 'Tess']);
        measure();
        feature.initialize();
        await flush();
        expect(visual()).toEqual(['Tess', 'sam', 'dan', 'Dora', 'Ned']);
        const grid = document.querySelector('[class*="MiniUnitGrid_miniUnitGrid"]');
        expect(grid.hasAttribute(GRID_MARK)).toBe(true);
        expect(grid.style.gridTemplateColumns).toMatch(/^130px /);
        const card = document.querySelector('[class*="CombatUnit_combatUnit"]');
        expect(card.style.gridRow).toBe('1 / span 3');
        expect(card.style.gridColumn).toBe('1 / 2');
        const css = document.getElementById(STYLE_ID).textContent;
        expect(css).toContain('display: grid !important');
        expect(css).toContain('display: contents !important');
        // scoped to the two trial areas
        expect(css).toContain('BattlePanel_guildPartyArea');
        expect(css).toContain('SkillingInstancePanel_playerArea');
        expect(css).not.toContain('BattlePanel_playersArea');
        // the game's nodes are never moved
        const domOrder = [...document.querySelectorAll('[data-n]')].map((e) => e.dataset.n);
        expect(domOrder).toEqual(['Ned', 'Dora', 'sam', 'dan', 'Tess']);
    });

    test('no role last, and a member missing from guild data or signed up another week has no role', async () => {
        game.members.push(member('Abe', 'tank', { signupWeekStartAt: '2026-10-26T00:00:00Z' }));
        document.body.innerHTML = COMBAT(['Zoe', 'Abe', 'Ned', 'Tess']);
        measure();
        feature.initialize();
        await flush();
        expect(visual()).toEqual(['Tess', 'Abe', 'Ned', 'Zoe']);
    });

    test('a rotated re-render keeps every player in the same place', async () => {
        const names = ['Ned', 'Dora', 'sam', 'dan', 'Tess'];
        document.body.innerHTML = COMBAT(names);
        measure();
        feature.initialize();
        await flush();
        const before = Object.fromEntries(names.map((n) => [n, at(n)]));
        // The game re-renders the same ring starting from another player
        const rotated = [...names.slice(2), ...names.slice(0, 2)];
        const grid = document.querySelector('[class*="MiniUnitGrid_miniUnitGrid"]');
        for (const col of [...grid.querySelectorAll('[class*="miniUnitColumn"]')]) col.remove();
        const fresh = document.createElement('div');
        fresh.innerHTML = COMBAT(rotated, 'tmp');
        for (const col of [...fresh.querySelectorAll('[class*="miniUnitColumn"]')]) grid.appendChild(col);
        measure();
        await tick();
        await flush();
        expect(Object.fromEntries(names.map((n) => [n, at(n)]))).toEqual(before);
    });

    test('names rewritten in place (same nodes) re-sort them', async () => {
        document.body.innerHTML = COMBAT(['Tess', 'sam']);
        measure();
        feature.initialize();
        await flush();
        expect(at('Tess')[0]).toBe('1');
        // React reuses the nodes and swaps the names
        const [a, b] = document.querySelectorAll('[class*="MiniUnit_name"]');
        a.firstChild.data = 'sam';
        b.firstChild.data = 'Tess';
        await tick();
        await flush();
        expect(a.parentElement.style.gridRow).toBe('2');
        expect(b.parentElement.style.gridRow).toBe('1');
    });

    test('a newcomer takes their sorted place; a leaver leaves no gap', async () => {
        document.body.innerHTML = COMBAT(['Ned', 'Tess', 'dan']);
        measure();
        feature.initialize();
        await flush();
        const col = document.querySelector('[class*="miniUnitColumn"]');
        const fresh = document.createElement('div');
        fresh.innerHTML = COMBAT(['sam'], 'tmp');
        col.parentElement.appendChild(fresh.querySelector('[class*="miniUnitColumn"]'));
        measure();
        await tick();
        await flush();
        expect(visual()).toEqual(['Tess', 'sam', 'dan', 'Ned']);
        tile('sam').remove();
        await tick();
        await flush();
        expect(visual()).toEqual(['Tess', 'dan', 'Ned']);
        expect(['Tess', 'dan', 'Ned'].map((n) => at(n)[0])).toEqual(['1', '2', '3']);
    });

    test('a role change re-sorts through the roster listener', async () => {
        document.body.innerHTML = COMBAT(['Ned', 'Tess']);
        measure();
        feature.initialize();
        await flush();
        expect(visual()).toEqual(['Tess', 'Ned']);
        game.members = game.members.map((m) => (m.name === 'Ned' ? { ...m, signedUpCombatRoleHrid: 'tank' } : m));
        for (const fn of game.metaListeners) fn();
        await flush();
        expect(visual()).toEqual(['Ned', 'Tess']);
    });

    test('skilling trial: alphabetical, roles ignored', async () => {
        document.body.innerHTML = SKILLING(['Tess', 'dan', 'Ned', 'Dora']);
        measure();
        feature.initialize();
        await flush();
        expect(visual()).toEqual(['dan', 'Dora', 'Ned', 'Tess']);
    });

    test('overflow tiles go in rows under the card, left to right', async () => {
        const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
        document.body.innerHTML = SKILLING(names);
        measure(240); // two stacks beside, four a row under
        feature.initialize();
        await flush();
        expect(names.map((n) => at(n)[0])).toEqual(['1', '2', '3', '1', '2', '3', '4', '4']);
        const grid = document.querySelector('[class*="MiniUnitGrid_miniUnitGrid"]');
        const widths = grid.style.gridTemplateColumns.split(' ').map((w) => parseFloat(w));
        const edges = [0];
        for (const w of widths) edges.push(edges.at(-1) + w);
        const left = (n) => edges[columnOf(n) - 1];
        expect([left('a7'), left('a8')]).toEqual([0, 51]);
        expect([left('a1'), left('a4')]).toEqual([134, 185]);
        // resize: everything fits beside now
        measure(900);
        window.dispatchEvent(new Event('resize'));
        await flush();
        expect(names.map((n) => at(n)[0])).toEqual(['1', '2', '3', '1', '2', '3', '1', '2']);
    });

    test('the width comes from the area, so a grid sized to its tracks does not shrink the layout', async () => {
        const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
        document.body.innerHTML = SKILLING(names);
        measure(240);
        feature.initialize();
        await flush();
        const before = names.map((n) => at(n));
        // A content-sized grid now reports only the width of the tracks it was given
        const grid = document.querySelector('[class*="MiniUnitGrid_miniUnitGrid"]');
        const used = grid.style.gridTemplateColumns.split(' ').reduce((sum, w) => sum + parseFloat(w), 0);
        width(grid, used - 60);
        for (let i = 0; i < 3; i++) {
            window.dispatchEvent(new Event('resize'));
            await flush();
        }
        expect(names.map((n) => at(n))).toEqual(before);
    });

    test('a normal party fight is never touched', async () => {
        document.body.innerHTML = COMBAT(['Tess']) + NORMAL(['zed', 'amy']);
        measure();
        feature.initialize();
        await flush();
        const normal = document.getElementById('n');
        expect(normal.querySelector(`[${GRID_MARK}]`)).toBe(null);
        expect(normal.querySelector(`[${PLACED_MARK}]`)).toBe(null);
        expect(tile('zed', normal).style.gridRow).toBe('');
    });

    test('an area that cannot be measured is left alone', async () => {
        document.body.innerHTML = COMBAT(['Tess', 'Ned']);
        feature.initialize();
        await flush();
        expect(document.querySelector(`[${GRID_MARK}]`)).toBe(null);
        expect(document.getElementById(STYLE_ID)).toBe(null);
    });

    test('setting off restores everything and stops; on redoes it', async () => {
        document.body.innerHTML = COMBAT(['Ned', 'Tess']);
        measure();
        tile('Ned').style.position = 'relative'; // a badge's positioning context stays
        feature.initialize();
        await flush();
        const listener = game.listeners.find((l) => l.key === SETTING);
        listener.fn(false);
        expect(document.querySelector(`[${GRID_MARK}]`)).toBe(null);
        expect(document.querySelector(`[${PLACED_MARK}]`)).toBe(null);
        expect(document.getElementById(STYLE_ID)).toBe(null);
        expect(document.querySelector('[class*="MiniUnitGrid_miniUnitGrid"]').style.gridTemplateColumns).toBe('');
        expect(at('Ned')).toEqual(['', '']);
        expect(tile('Ned').style.position).toBe('relative');
        expect(game.metaListeners.length).toBe(0);
        window.dispatchEvent(new Event('resize'));
        await flush();
        expect(at('Ned')).toEqual(['', '']);
        listener.fn(true);
        await flush();
        expect(at('Tess')[0]).toBe('1');
        expect(document.getElementById(STYLE_ID)).not.toBe(null);
    });

    test('default off at start does nothing', async () => {
        game.settings[SETTING] = false;
        document.body.innerHTML = COMBAT(['Ned']);
        measure();
        feature.initialize();
        await flush();
        expect(at('Ned')).toEqual(['', '']);
    });

    test('an area leaving restores the stylesheet; cleanup and re-initialize', async () => {
        document.body.innerHTML = COMBAT(['Ned', 'Tess']);
        measure();
        feature.initialize();
        await flush();
        const spy = vi.spyOn(window, 'removeEventListener');
        feature.cleanup();
        expect(spy).toHaveBeenCalledWith('resize', expect.any(Function));
        spy.mockRestore();
        expect(document.querySelector(`[${PLACED_MARK}]`)).toBe(null);
        expect(game.listeners.length).toBe(0);
        feature.initialize();
        await flush();
        expect(at('Tess')[0]).toBe('1');
        expect(game.listeners.length).toBe(1);
        document.getElementById('a').remove();
        await tick();
        await flush();
        expect(document.getElementById(STYLE_ID)).toBe(null);
    });
});
