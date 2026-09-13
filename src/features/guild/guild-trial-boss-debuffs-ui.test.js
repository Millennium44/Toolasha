/** @vitest-environment happy-dom */

/**
 * The boss debuff strip on a spectated trial's fight view.
 *
 * The timers are `guild-trial-boss-debuffs.js`' and are tested there; what is
 * worth asserting here is where they are drawn — a trial's boss tiles and never
 * this character's own fight — and that switching the setting takes them down.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ settings: {}, listeners: {}, live: null, observers: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : fallback),
        onSettingChange: (key, callback) => {
            (game.listeners[key] ||= []).push(callback);
            return () => {
                game.listeners[key] = (game.listeners[key] || []).filter((entry) => entry !== callback);
            };
        },
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, _classes, callback) => {
            game.observers[name] = callback;
            return () => delete game.observers[name];
        },
    },
}));
// The buff bars' real guild-panel test and countdown, without the module's own socket wiring
vi.mock('../combat/combat-unit-buff-bars.js', () => ({
    isTrialArea: (area) => Boolean(area?.closest?.('[class*="GuildPanel"]')),
    countdownText: (expiresAt, now) =>
        expiresAt === null ? '' : String(Math.max(0, Math.ceil((expiresAt - now) / 1000))),
    abilitySpriteHref: () => null,
}));
vi.mock('./guild-trial-damage.js', () => ({ liveBossDebuffs: () => game.live }));

const { default: feature, CHIP_MARK, STRIP_MARK, SETTING } = await import('./guild-trial-boss-debuffs-ui.js');

const now = 1_800_000_000_000;

/** A fight view: a trial's inside the guild panel, and this character's own beside it */
function fightViews() {
    const monsters = (names) =>
        `<div class="BattlePanel_monstersArea__m">${names
            .map((name) => `<div class="CombatUnit_combatUnit__u"><div class="CombatUnit_name__n">${name}</div></div>`)
            .join('')}</div>`;
    document.body.innerHTML =
        `<div class="GuildPanel_guildPanel__g">${monsters(['Trial Badger', 'Trial Badger'])}</div>` +
        `<div class="MainPanel_main__x">${monsters(['Jerry'])}</div>`;
}

const tiles = (area) => [...document.querySelectorAll(`${area} [class*="CombatUnit_combatUnit"]`)];
const iceSpear = {
    key: '/abilities/ice_spear',
    kind: 'debuff',
    name: 'Ice Spear',
    label: 'ICE',
    expiresAt: now + 8000,
};
const stun = { key: 'stun', kind: 'stun', name: 'Stunned by Entangle', label: 'STN', expiresAt: now + 2000 };

/**
 * Flip the setting the way `config.setSetting` does.
 * @param {boolean} value - Its new value
 */
function flip(value) {
    game.settings[SETTING] = value;
    for (const callback of game.listeners[SETTING] || []) callback(value);
}

beforeEach(() => {
    vi.useFakeTimers();
    game.settings = {};
    game.listeners = {};
    game.observers = {};
    game.live = null;
    fightViews();
});

afterEach(() => {
    feature.cleanup();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('the boss debuff strip', () => {
    test('each trial boss wears its own effects by slot, stun first, with countdowns', () => {
        game.live = new Map([
            ['0', [stun, iceSpear]],
            ['1', [iceSpear]],
        ]);
        feature.initialize();
        feature.redraw(now);

        const [first, second] = tiles('[class*="GuildPanel"]');
        const chips = (tile) =>
            [...tile.querySelectorAll(`[${CHIP_MARK}]`)].map((chip) => [
                chip.getAttribute(CHIP_MARK),
                chip.textContent,
            ]);
        expect(chips(first)).toEqual([
            ['stun', 'STN2'],
            ['/abilities/ice_spear', 'ICE8'],
        ]);
        expect(chips(second)).toEqual([['/abilities/ice_spear', 'ICE8']]);
        expect(first.querySelector(`[${CHIP_MARK}]`).title).toContain('trial stream states the stun');
    });

    test('this character’s own fight is never drawn on', () => {
        game.live = new Map([['0', [iceSpear]]]);
        feature.initialize();
        feature.redraw(now);

        expect(tiles('[class*="MainPanel"]')[0].querySelector(`[${STRIP_MARK}]`)).toBeNull();
    });

    test('a countdown moves, an effect that is gone goes, and a quiet stream clears the strip', () => {
        game.live = new Map([['0', [stun, iceSpear]]]);
        feature.initialize();
        feature.redraw(now);

        game.live = new Map([['0', [iceSpear]]]);
        feature.redraw(now + 3000);
        const tile = tiles('[class*="GuildPanel"]')[0];
        expect([...tile.querySelectorAll(`[${CHIP_MARK}]`)].map((chip) => chip.textContent)).toEqual(['ICE5']);

        game.live = null;
        feature.redraw(now + 4000);
        expect(document.querySelector(`[${STRIP_MARK}]`)).toBeNull();
    });

    test('the one-second timer redraws while it is on', () => {
        game.live = new Map([['0', [iceSpear]]]);
        feature.initialize();
        vi.advanceTimersByTime(1000);

        expect(document.querySelectorAll(`[${STRIP_MARK}]`)).toHaveLength(1);
    });

    test('switched off it takes its strips down and stops; switched on it draws again', () => {
        game.live = new Map([['0', [iceSpear]]]);
        feature.initialize();
        feature.redraw(now);

        flip(false);
        expect(document.querySelector(`[${STRIP_MARK}]`)).toBeNull();
        expect(game.observers.GuildTrialBossDebuffs).toBeUndefined();
        vi.advanceTimersByTime(3000);
        expect(document.querySelector(`[${STRIP_MARK}]`)).toBeNull();

        flip(true);
        vi.advanceTimersByTime(1000);
        expect(document.querySelectorAll(`[${STRIP_MARK}]`)).toHaveLength(1);
    });

    test('off at start draws nothing, and cleanup stops following the setting', () => {
        game.settings[SETTING] = false;
        game.live = new Map([['0', [iceSpear]]]);
        feature.initialize();
        vi.advanceTimersByTime(2000);
        expect(document.querySelector(`[${STRIP_MARK}]`)).toBeNull();

        feature.cleanup();
        expect(game.listeners[SETTING]).toEqual([]);
    });
});
