/** @vitest-environment happy-dom
 *
 * What a battle tick is allowed to cost.
 *
 * `battle_updated` arrives several times a second for as long as a fight lasts,
 * and the floating numbers used to answer "where are the units" with a
 * whole-document class query every single time, plus a `getComputedStyle` per
 * unit. The tiles only change when the battle panel is rebuilt, so that is what
 * this asserts: one lookup, reused, dropped when the panel or the battle changes.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ battle: null, newBattle: null, areaCallback: null }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: vi.fn(() => true), onSettingChange: vi.fn(), Z_HUD: 50 },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: vi.fn((event, handler) => {
            if (event === 'battle_updated') hooks.battle = handler;
            if (event === 'new_battle') hooks.newBattle = handler;
        }),
        off: vi.fn(),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn((_name, _classes, callback) => {
            hooks.areaCallback = callback;
            return () => {};
        }),
    },
}));
vi.mock('../../utils/simple-panel.js', () => ({
    createPanel: () => ({ toggle: () => {}, show: () => {}, hide: () => {} }),
    panelCard: () => document.createElement('div'),
    panelLine: () => document.createElement('div'),
    panelNote: () => document.createElement('div'),
}));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: vi.fn() }));

const combatText = (await import('./combat-text.js')).default;

/** Put a battle panel with two monster tiles and one player tile on screen */
function mountBattlePanel() {
    document.body.innerHTML = `
        <div class="BattlePanel_playersArea__1a2b">
            <div class="BattlePanel_monster__x1"></div>
            <div class="BattlePanel_monster__x2"></div>
            <div class="BattlePanel_player__y1"></div>
        </div>`;
}

let health = 1000;

/**
 * A tick in which the party takes a hit.
 *
 * Health only, because that is the path with no ability names behind it —
 * `healthDeltas` needs a previous reading, so the first call of a battle
 * establishes one and the ones after it produce events.
 *
 * @param {string} battleId - Which battle it belongs to
 * @returns {Object} A `battle_updated` payload
 */
function tick(battleId = 'b1') {
    health -= 10;
    return {
        battleId,
        mMap: { 0: { currentHitpoints: health } },
        pMap: { 0: { currentHitpoints: health } },
    };
}

beforeEach(() => {
    health = 1000;
    mountBattlePanel();
    vi.spyOn(document, 'querySelectorAll');
    combatText.initialize();
});

afterEach(() => {
    combatText.cleanup();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('the unit tiles are looked up once, not per tick', () => {
    test('a run of ticks costs one query for the tiles', () => {
        hooks.battle(tick()); // establishes the health to compare against
        document.querySelectorAll.mockClear();
        for (let i = 0; i < 5; i++) hooks.battle(tick());

        const tileQueries = document.querySelectorAll.mock.calls.filter((call) =>
            String(call[0]).includes('BattlePanel_monster')
        );
        expect(tileQueries).toHaveLength(1);
    });

    test('a new battle drops the held tiles', () => {
        hooks.battle(tick('b1'));
        hooks.battle(tick('b1'));
        document.querySelectorAll.mockClear();

        hooks.battle(tick('b2'));
        hooks.battle(tick('b2'));

        const tileQueries = document.querySelectorAll.mock.calls.filter((call) =>
            String(call[0]).includes('BattlePanel_monster')
        );
        expect(tileQueries).toHaveLength(1);
    });

    test('the battle panel being rebuilt drops them too', () => {
        hooks.battle(tick());
        hooks.battle(tick());
        document.querySelectorAll.mockClear();

        mountBattlePanel();
        hooks.areaCallback(document.querySelector('[class*="BattlePanel_playersArea"]'));
        hooks.battle(tick());

        const tileQueries = document.querySelectorAll.mock.calls.filter((call) =>
            String(call[0]).includes('BattlePanel_monster')
        );
        expect(tileQueries).toHaveLength(1);
    });
});

describe('a tab nobody is looking at', () => {
    test('draws nothing at all', () => {
        hooks.battle(tick());
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        document.querySelectorAll.mockClear();

        hooks.battle(tick());

        const tileQueries = document.querySelectorAll.mock.calls.filter((call) =>
            String(call[0]).includes('BattlePanel_monster')
        );
        expect(tileQueries).toHaveLength(0);
    });
});

describe('making a tile a positioning context', () => {
    test('asks the computed style once per tile, not once per tick', () => {
        const computed = vi.spyOn(window, 'getComputedStyle');
        for (let i = 0; i < 5; i++) hooks.battle(tick());

        // One tile took damage each tick; only the first pass may measure it
        expect(computed.mock.calls.length).toBeLessThanOrEqual(2);
    });
});
