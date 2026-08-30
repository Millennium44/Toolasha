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

// A faithful-enough stand-in for config's onSettingChange: real subscribe/
// unsubscribe bookkeeping, so a test can prove a listener from a torn-down
// `initialize()` either does or does not still fire.
const settingListeners = vi.hoisted(() => ({}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn(() => true),
        onSettingChange: vi.fn((key, callback) => {
            (settingListeners[key] ??= []).push(callback);
            return () => {
                settingListeners[key] = (settingListeners[key] || []).filter((cb) => cb !== callback);
            };
        }),
        Z_HUD: 50,
    },
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

/**
 * Put a battle panel on screen, shaped the way the game builds one.
 *
 * The two *Area wrappers matter: their class names contain the tile prefixes as
 * substrings, so a plain `[class*=]` match picks them up alongside the tiles
 * they contain. Every unit here is identifiable so a test can say which tile a
 * number landed on.
 */
function mountBattlePanel() {
    document.body.innerHTML = `
        <div class="BattlePanel_monstersArea__0a0b">
            <div class="BattlePanel_monster__x1" data-unit="monster-0"></div>
            <div class="BattlePanel_monster__x2" data-unit="monster-1"></div>
        </div>
        <div class="BattlePanel_playersArea__1a2b">
            <div class="BattlePanel_player__y1" data-unit="player-0"></div>
            <div class="BattlePanel_player__y2" data-unit="player-1"></div>
        </div>`;
}

/** Which units currently carry a floating number */
function floatedUnits() {
    return Array.from(document.querySelectorAll('.toolasha-floating-combat-text')).map(
        (node) => node.parentElement?.dataset.unit
    );
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
    for (const key of Object.keys(settingListeners)) delete settingListeners[key];
});

describe('cleanup unregisters the setting-change listeners it registered', () => {
    test('a setting change after cleanup does not resurrect the feature', async () => {
        const websocketHook = (await import('../../core/websocket.js')).default;

        // initialize() (in beforeEach) subscribed applySettings to both
        // settings; cleanup() tears the feature down the way a character
        // switch or a toggle-off does
        combatText.cleanup();
        websocketHook.on.mockClear();

        // Something else changes the Floating/Scrolling setting afterwards —
        // another character's config reloading, or the settings panel firing
        // its change event a tick late. A listener still on config's list
        // would see this and, finding `handler` null, resubscribe: the
        // feature comes back to life with no `initialize()` behind it, and
        // every character switch since boot would have pushed one more copy
        // of the same callback onto config's list.
        for (const callback of settingListeners.combatText_floating || []) callback(true);

        expect(websocketHook.on).not.toHaveBeenCalled();
    });
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

/** Remove every floating number already on screen, so the next tick stands alone */
function clearFloats() {
    for (const node of document.querySelectorAll('.toolasha-floating-combat-text')) node.remove();
}

describe('which unit a number lands on', () => {
    test('the wrapper divs do not take a slot in the join', () => {
        // pMap key 0 is the first *player*. With the two *Area wrappers in the
        // tile list the ally number landed on the monsters wrapper instead, and
        // the wrapper is not a unit, so nothing identified it as wrong.
        hooks.battle(tick()); // establishes the baseline health
        clearFloats();
        hooks.battle(tick());

        expect(floatedUnits().sort()).toEqual(['monster-0', 'player-0']);
    });

    test('a re-rendered panel is not drawn onto the detached tiles', () => {
        hooks.battle(tick());
        hooks.battle(tick());
        const stale = document.querySelector('[data-unit="player-0"]');
        const before = stale.childElementCount;

        // The game replaces the units but leaves the areas in place, which is
        // exactly the case the old freshness check could not see: it held the
        // wrapper, the wrapper was still connected, so the stale list stood.
        document.querySelector('[class*="BattlePanel_playersArea"]').innerHTML =
            '<div class="BattlePanel_player__z1" data-unit="player-0"></div>';
        clearFloats();
        hooks.battle(tick());

        expect(stale.childElementCount).toBe(before);
        expect(floatedUnits().sort()).toEqual(['monster-0', 'player-0']);
    });
});
